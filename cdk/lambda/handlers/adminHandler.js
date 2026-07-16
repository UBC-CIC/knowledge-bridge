/**
 * AWS Lambda Handler for Admin Operations
 *
 * This Lambda function handles HTTP requests for administrative operations including:
 * - Admin user management (create, read, update, delete)
 * - System administration tasks
 * - Content management operations
 *
 * This handler requires admin-level authentication via AWS Cognito.
 * Only authenticated admin users can access these endpoints.
 */

const { getCorsHeaders } = require("./utils/cors.js");
const { getAuthenticatedUserId, buildAuditEntry } = require("./utils/handlerUtils.js");
const { GlueClient, StartJobRunCommand, GetJobRunCommand, BatchStopJobRunCommand } = require("@aws-sdk/client-glue");
const { CloudWatchLogsClient, GetLogEventsCommand, DescribeLogStreamsCommand } = require("@aws-sdk/client-cloudwatch-logs");
const { SchedulerClient, GetScheduleCommand, CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand } = require("@aws-sdk/client-scheduler");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { initConnection, getSqlConnection } = require("./initializeConnection.js");

const PRESIGN_TTL = 900; // 15 minutes

const glueClient = new GlueClient({});
const logsClient = new CloudWatchLogsClient({});
const schedulerClient = new SchedulerClient({});
const sqsClient = new SQSClient({});
const s3Client = new S3Client({});

const createResponse = async (event) => ({
    statusCode: 200,
    headers: await getCorsHeaders(event),
    body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", error);
  response.body = JSON.stringify({ error: "Internal server error" });
};

/**
 * Main Lambda handler function
 * @param {Object} event - AWS Lambda event object containing HTTP request data
 * @returns {Object} HTTP response object with statusCode, headers, and body
 */
exports.handler = async (event) => {
  // EventBridge Scheduler invocations have no httpMethod — run trigger logic directly
  if (!event.httpMethod) {
    await initConnection();
    const forceFull = event.force_full === true ? "true" : "false";
    const jobName = process.env.GLUE_JOB_NAME;
    if (!jobName) {
      console.error("GLUE_JOB_NAME not configured for scheduled invocation");
      return;
    }
    const inFlight = await getSqlConnection()`
      SELECT id FROM ingestion_runs
      WHERE run_type = 'site' AND status IN ('running', 'stopping')
      LIMIT 1
    `;
    if (inFlight.length > 0) {
      console.log("Scheduled trigger skipped — a job is already in-flight");
      return;
    }
    const scheduleRow = await getSqlConnection()`SELECT updated_by FROM ingestion_schedule LIMIT 1`;
    const scheduledByUserId = scheduleRow[0]?.updated_by?.toString() ?? null;
    const metadataJson = {
      force_full: forceFull === "true",
      job_name: jobName,
      triggered_by: "scheduler",
      ...(scheduledByUserId ? { triggered_by_user_id: scheduledByUserId } : {}),
    };
    const inserted = await getSqlConnection()`
      INSERT INTO ingestion_runs (run_type, triggered_by, status, started_at, metadata)
      VALUES ('site', 'scheduler', 'running', now(), ${JSON.stringify(metadataJson)}::jsonb)
      RETURNING id
    `;
    const ingestionRunId = inserted[0].id;
    const glueResp = await glueClient.send(new StartJobRunCommand({
      JobName: jobName,
      Arguments: {
        "--FORCE_FULL": forceFull,
        "--TRIGGERED_BY": "scheduler",
        "--INGESTION_RUN_ID": ingestionRunId,
      },
    }));
    await getSqlConnection()`
      UPDATE ingestion_runs SET glue_run_id = ${glueResp.JobRunId} WHERE id = ${ingestionRunId}
    `;
    console.log(`Scheduled ingestion started: runId=${ingestionRunId} glueRunId=${glueResp.JobRunId}`);
    return;
  }

  const response = await createResponse(event);

  const callerRole = event.requestContext?.authorizer?.role;
  if (callerRole !== 'admin') {
    response.statusCode = 403;
    response.body = JSON.stringify({ error: 'Admin access required' });
    return response;
  }

  // Ensure database connection is ready
  await initConnection();

  let data; // Variable to store response data
  try {
    // Route requests based on HTTP method and URL path
    const pathData = event.httpMethod + " " + event.resource;

    // Handle different API endpoints using switch statement
    switch (pathData) {
      // GET /admin/exampleEndpoint - Test endpoint for development and debugging
      case "GET /admin/exampleEndpoint":
        // Simple test response to verify Lambda function is working
        data = "Example endpoint invoked";
        response.body = JSON.stringify(data);
        break;

      // POST /admin/promote_user - Update an existing user's email + role
      case "POST /admin/promote_user": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const userId = body?.user_id;
        const email = (body?.email || "").trim().toLowerCase();

        console.log(JSON.stringify(buildAuditEntry(getAuthenticatedUserId(event), "promote_user", userId)));

        if (!userId) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "user_id is required" });
          break;
        }

        if (!email) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "email is required" });
          break;
        }

        const updated = await getSqlConnection()`
          UPDATE users
          SET
            email = ${email},
            last_seen_at = NOW()
          WHERE id = ${userId}::uuid
          RETURNING
            id,
            email,
            display_name,
            created_at,
            last_seen_at,
            messages_sent,
            messages_window_started_at,
            metadata
        `;

        if (updated.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "User not found" });
          break;
        }

        response.statusCode = 200;
        response.body = JSON.stringify(updated[0]);
        break;
      }

      // Fetch all system messages with version history
      case "GET /admin/system-messages": {
        const rows = await getSqlConnection()`
          SELECT
            sm.id,
            sm.type,
            sm.content,
            sm.character_limit,
            sm.version,
            sm.is_active,
            sm.affects_text_generation,
            sm.created_by,
            sm.created_at,
            u.email AS created_by_email
          FROM system_messages sm
          LEFT JOIN users u ON u.id = sm.created_by
          ORDER BY
            sm.type ASC,
            sm.is_active DESC,
            sm.version DESC,
            sm.created_at DESC
        `;

        // Group into { [type]: SystemMessageVersion[] }
        const grouped = {};
        for (const r of rows) {
          if (!grouped[r.type]) grouped[r.type] = [];
          grouped[r.type].push({
            id: r.id,
            type: r.type,
            content: r.content,
            character_limit: r.character_limit,
            version: r.version,
            is_active: r.is_active,
            affects_text_generation: r.affects_text_generation,
            created_by: r.created_by ?? null,
            created_by_email: r.created_by_email ?? null,
            created_at: r.created_at,
          });
        }

        response.statusCode = 200;
        response.body = JSON.stringify(grouped);
        break;
      }

      // Create new system message version + set active
      case "POST /admin/system-messages/{system_message_type}": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const messageType = event?.pathParameters?.system_message_type;

        const allowedTypes = new Set([
          "disclaimer",
          "guardrails",
          "system_role",
          "system_instructions",
          "output_format",
          "initial_prompt",
          "welcome_message",
          "partial_hallucination_warning",
          "full_hallucination_warning",
        ]);

        // Validate system_message_type
        if (!messageType || typeof messageType !== "string" || !allowedTypes.has(messageType)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid system_message_type",
            allowed: Array.from(allowedTypes),
          });
          break;
        }

        // Validate content
        const content = typeof body?.content === "string" ? body.content.trim() : "";
        if (!content) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "content is required" });
          break;
        }

        const createdByUserId = getAuthenticatedUserId(event);
        if (!createdByUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        console.log(JSON.stringify(buildAuditEntry(createdByUserId, "create_system_message", messageType)));

        // Create new version, make it active, deactivate old
        try {
          const created = await getSqlConnection().begin(async (tx) => {
            const [{ next_version }] = await tx`
              SELECT COALESCE(MAX(version), 0) + 1 AS next_version
              FROM system_messages
              WHERE type = ${messageType}::system_message_type
            `;

            const limitRows = await tx`
              SELECT character_limit
              FROM system_messages
              WHERE type = ${messageType}::system_message_type
              ORDER BY is_active DESC, version DESC, created_at DESC
              LIMIT 1
            `;

            const defaultCharacterLimit =
              messageType === "guardrails" || messageType === "system_instructions"
                ? 1000
                : 700;

            const characterLimit =
              limitRows.length > 0 && typeof limitRows[0].character_limit === "number"
                ? limitRows[0].character_limit
                : defaultCharacterLimit;

            if (content.length > characterLimit) {
              return {
                kind: "too_long",
                character_limit: characterLimit,
                content_length: content.length,
              };
            }

            await tx`
              UPDATE system_messages
              SET is_active = false
              WHERE type = ${messageType}::system_message_type
                AND is_active = true
            `;

            const inserted = await tx`
              INSERT INTO system_messages (
                type,
                content,
                character_limit,
                version,
                is_active,
                created_by,
                created_at
              )
              VALUES (
                ${messageType}::system_message_type,
                ${content},
                ${characterLimit},
                ${next_version},
                true,
                ${createdByUserId},
                NOW()
              )
              RETURNING id
            `;

            const out = await tx`
              SELECT
                sm.id,
                sm.type,
                sm.content,
                sm.character_limit,
                sm.version,
                sm.is_active,
                sm.affects_text_generation,
                sm.created_by,
                u.email AS created_by_email,
                sm.created_at
              FROM system_messages sm
              LEFT JOIN users u ON u.id = sm.created_by
              WHERE sm.id = ${inserted[0].id}
              LIMIT 1
            `;

            return {
              kind: "created",
              row: out[0],
            };
          });

          if (created.kind === "too_long") {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "content exceeds character_limit",
              character_limit: created.character_limit,
              content_length: created.content_length,
            });
            break;
          }

          response.statusCode = 200;
          response.body = JSON.stringify(created.row);
          break;
        } catch (err) {
          console.error("POST /admin/system-messages/{system_message_type} failed:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Failed to create system message version" });
          break;
        }
      }

      // Delete a non-active system message version
      case "DELETE /admin/system-messages/{system_message_type}/{version_id}": {
        try {
          parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const messageType = event?.pathParameters?.system_message_type;
        const versionId = event?.pathParameters?.version_id;

        const allowedTypes = new Set([
          "disclaimer",
          "guardrails",
          "system_role",
          "system_instructions",
          "output_format",
          "initial_prompt",
          "welcome_message",
          "partial_hallucination_warning",
          "full_hallucination_warning",
        ]);

        // Validate path params
        if (!messageType || typeof messageType !== "string" || !allowedTypes.has(messageType)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid system_message_type",
            allowed: Array.from(allowedTypes),
          });
          break;
        }

        if (!versionId || typeof versionId !== "string") {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "version_id is required" });
          break;
        }

        const callerUserId = getAuthenticatedUserId(event);
        if (!callerUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        console.log(JSON.stringify(buildAuditEntry(callerUserId, "delete_system_message", versionId, { messageType })));

        try {
          const deleted = await getSqlConnection().begin(async (tx) => {
            const targetRows = await tx`
              SELECT id, type, version, is_active
              FROM system_messages
              WHERE id = ${versionId}
                AND type = ${messageType}::system_message_type
              FOR UPDATE
            `;

            if (targetRows.length === 0) {
              return { kind: "not_found" };
            }

            const target = targetRows[0];

            if (target.is_active) {
              return { kind: "active_forbidden", version: target.version };
            }

            const removed = await tx`
              DELETE FROM system_messages
              WHERE id = ${versionId}
                AND type = ${messageType}::system_message_type
              RETURNING id, type, version
            `;

            if (removed.length === 0) {
              return { kind: "not_found" };
            }

            return {
              kind: "deleted",
              id: removed[0].id,
              type: removed[0].type,
              version: removed[0].version,
            };
          });

          if (deleted.kind === "not_found") {
            response.statusCode = 404;
            response.body = JSON.stringify({
              error: "System message version not found for given type/version_id",
            });
            break;
          }

          if (deleted.kind === "active_forbidden") {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "Cannot delete the active version",
              version: deleted.version,
            });
            break;
          }

          response.statusCode = 200;
          response.body = JSON.stringify({
            success: true,
            deleted: {
              id: deleted.id,
              type: deleted.type,
              version: deleted.version,
            },
          });
          break;
        } catch (err) {
          console.error("DELETE /admin/system-messages/{system_message_type}/{version_id} failed:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Failed to delete system message version" });
          break;
        }
      }

      // Activate a historical version
      case "POST /admin/system-messages/{system_message_type}/{version_id}/activate": {
        try {
          parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const messageType = event?.pathParameters?.system_message_type;
        const versionId = event?.pathParameters?.version_id;

        const allowedTypes = new Set([
          "disclaimer",
          "guardrails",
          "system_role",
          "system_instructions",
          "output_format",
          "initial_prompt",
          "welcome_message",
          "partial_hallucination_warning",
          "full_hallucination_warning",
        ]);

        // Validate path params
        if (!messageType || typeof messageType !== "string" || !allowedTypes.has(messageType)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid system_message_type",
            allowed: Array.from(allowedTypes),
          });
          break;
        }

        if (!versionId || typeof versionId !== "string") {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "version_id is required" });
          break;
        }

        const callerUserId = getAuthenticatedUserId(event);
        if (!callerUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        console.log(JSON.stringify(buildAuditEntry(callerUserId, "activate_system_message", versionId, { messageType })));

        try {
          const result = await getSqlConnection().begin(async (tx) => {
            // Lock target row and verify it exists + belongs to specified type
            const targetRows = await tx`
              SELECT id, type, version, is_active
              FROM system_messages
              WHERE id = ${versionId}
                AND type = ${messageType}::system_message_type
              FOR UPDATE
            `;

            if (targetRows.length === 0) {
              return { kind: "not_found" };
            }

            const target = targetRows[0];

            // If already active, return success
            if (target.is_active) {
              const out = await tx`
                SELECT
                  sm.id,
                  sm.type,
                  sm.content,
                  sm.character_limit,
                  sm.version,
                  sm.is_active,
                  sm.affects_text_generation,
                  sm.created_by,
                  u.email AS created_by_email,
                  sm.created_at
                FROM system_messages sm
                LEFT JOIN users u ON u.id = sm.created_by
                WHERE sm.id = ${target.id}
                LIMIT 1
              `;

              return {
                kind: "already_active",
                activated: out[0],
                previous_active: null,
              };
            }

            // Find currently active version for this type (if any), lock it
            const previousActiveRows = await tx`
              SELECT id, version
              FROM system_messages
              WHERE type = ${messageType}::system_message_type
                AND is_active = true
              FOR UPDATE
            `;

            const previousActive = previousActiveRows[0] ?? null;

            // Deactivate all active rows for this type (defensive, in case of bad data)
            await tx`
              UPDATE system_messages
              SET is_active = false
              WHERE type = ${messageType}::system_message_type
                AND is_active = true
            `;

            // Activate target
            await tx`
              UPDATE system_messages
              SET is_active = true
              WHERE id = ${target.id}
            `;

            const out = await tx`
              SELECT
                sm.id,
                sm.type,
                sm.content,
                sm.character_limit,
                sm.version,
                sm.is_active,
                sm.affects_text_generation,
                sm.created_by,
                u.email AS created_by_email,
                sm.created_at
              FROM system_messages sm
              LEFT JOIN users u ON u.id = sm.created_by
              WHERE sm.id = ${target.id}
              LIMIT 1
            `;

            return {
              kind: "activated",
              activated: out[0],
              previous_active: previousActive
                ? {
                  id: previousActive.id,
                  version: previousActive.version,
                }
                : null,
            };
          });

          if (result.kind === "not_found") {
            response.statusCode = 404;
            response.body = JSON.stringify({
              error: "System message version not found for given type/version_id",
            });
            break;
          }

          // Both "already_active" and "activated" return 200
          response.statusCode = 200;
          response.body = JSON.stringify({
            success: true,
            status: result.kind === "already_active" ? "already_active" : "activated",
            activated: result.activated,
            previous_active: result.previous_active,
          });
          break;
        } catch (err) {
          console.error("POST /admin/system-messages/{system_message_type}/{version_id}/activate failed:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Failed to activate system message version" });
          break;
        }
      }

      // POST /admin/users - Create new admin user in the system
      case "POST /admin/users":
        // Parse JSON request body containing new user data
        let userData;
        try {
          userData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        // Extract user fields from request body
        const { display_name, email, institution_id } = userData;

        // Validate required fields
        if (!display_name || !email) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "display_name and email are required",
          });
          break;
        }

        // Insert new admin user into database
        // Using postgres library template literal syntax for better performance
        const result = await getSqlConnection()`
          INSERT INTO users (display_name, email, institution_id)
          VALUES (${display_name}, ${email}, ${institution_id || null})
          RETURNING id, display_name, email, institution_id, created_at
        `;

        response.statusCode = 201; // Created
        data = result[0];
        response.body = JSON.stringify(data);
        break;

      // Get analytics data
      case "GET /admin/analytics": {
        const qs = event.queryStringParameters ?? {};
        const groupId = qs.groupId && qs.groupId !== "all" ? qs.groupId : null;

        // "all" timeRange = no date cutoff; otherwise parse Nd/Nm/Ny
        const timeRangeParam = typeof qs.timeRange === "string" ? qs.timeRange.trim() : "";
        const isAllTime = timeRangeParam === "all";
        const timeRangeProvided = timeRangeParam.length > 0;

        // Resolve startDateIso — null means all-time
        let startDateIso = null;
        if (timeRangeProvided && !isAllTime) {
          let daysBack = 90;
          const m = timeRangeParam.match(/^(\d+)([dmy])$/);
          if (m) {
            const value = parseInt(m[1], 10);
            const unit = m[2];
            if (unit === "d") daysBack = value;
            if (unit === "m") daysBack = value * 30;
            if (unit === "y") daysBack = value * 365;
          }
          daysBack = Math.min(Math.max(1, daysBack), 365);
          const startDate = new Date();
          startDate.setDate(startDate.getDate() - daysBack);
          startDateIso = startDate.toISOString();
        }

        // Helper: compute totals scoped by optional groupId and optional startDate
        const fetchTotals = async () => {
          if (!startDateIso && !groupId) {
            const rows = await getSqlConnection()`
              SELECT
                (SELECT COUNT(DISTINCT cs.user_id)::int FROM chat_sessions cs) AS users,
                (SELECT COUNT(cs.id)::int FROM chat_sessions cs) AS chat_sessions,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm) AS messages,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm WHERE cm.sender = 'user') AS questions
            `;
            return rows[0];
          }
          if (!groupId) {
            const rows = await getSqlConnection()`
              SELECT
                (SELECT COUNT(DISTINCT cs.user_id)::int FROM chat_sessions cs WHERE cs.created_at >= ${startDateIso}) AS users,
                (SELECT COUNT(cs.id)::int FROM chat_sessions cs WHERE cs.created_at >= ${startDateIso}) AS chat_sessions,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm WHERE cm.created_at >= ${startDateIso}) AS messages,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm WHERE cm.created_at >= ${startDateIso} AND cm.sender = 'user') AS questions
            `;
            return rows[0];
          }
          if (!startDateIso) {
            const rows = await getSqlConnection()`
              SELECT
                (SELECT COUNT(DISTINCT cs.user_id)::int FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId}) AS users,
                (SELECT COUNT(cs.id)::int FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId}) AS chat_sessions,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId}) AS messages,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId} WHERE cm.sender = 'user') AS questions
            `;
            return rows[0];
          }
          const rows = await getSqlConnection()`
            SELECT
              (SELECT COUNT(DISTINCT cs.user_id)::int FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId} WHERE cs.created_at >= ${startDateIso}) AS users,
              (SELECT COUNT(cs.id)::int FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId} WHERE cs.created_at >= ${startDateIso}) AS chat_sessions,
              (SELECT COUNT(cm.id)::int FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId} WHERE cm.created_at >= ${startDateIso}) AS messages,
              (SELECT COUNT(cm.id)::int FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId} WHERE cm.created_at >= ${startDateIso} AND cm.sender = 'user') AS questions
          `;
          return rows[0];
        };

        if (!timeRangeProvided) {
          const totals = await fetchTotals();
          response.statusCode = 200;
          response.body = JSON.stringify({ totals });
          break;
        }

        // Time series — build dynamically based on groupId and startDateIso
        let timeSeries;
        if (!groupId && !startDateIso) {
          // All time, all groups
          timeSeries = await getSqlConnection()`
            WITH date_series AS (
              SELECT generate_series(
                DATE_TRUNC('day', (SELECT MIN(created_at) FROM chat_sessions)),
                DATE_TRUNC('day', NOW()),
                '1 day'::interval
              )::date AS date
            ),
            daily_chat_sessions AS (
              SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users
              FROM chat_sessions cs GROUP BY 1
            ),
            daily_questions AS (
              SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users
              FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id
              WHERE cm.sender = 'user' GROUP BY 1
            )
            SELECT TO_CHAR(ds.date, 'Mon DD') AS date,
              COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users,
              COALESCE(dq.questions, 0)::int AS questions,
              COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
            FROM date_series ds
            LEFT JOIN daily_chat_sessions dcs ON ds.date = dcs.date
            LEFT JOIN daily_questions dq ON ds.date = dq.date
            ORDER BY ds.date ASC
          `;
        } else if (!groupId) {
          // Date-filtered, all groups
          timeSeries = await getSqlConnection()`
            WITH date_series AS (
              SELECT generate_series(DATE_TRUNC('day', ${startDateIso}::timestamp), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date
            ),
            daily_chat_sessions AS (
              SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users
              FROM chat_sessions cs WHERE cs.created_at >= ${startDateIso} GROUP BY 1
            ),
            daily_questions AS (
              SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users
              FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id
              WHERE cm.created_at >= ${startDateIso} AND cm.sender = 'user' GROUP BY 1
            )
            SELECT TO_CHAR(ds.date, 'Mon DD') AS date,
              COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users,
              COALESCE(dq.questions, 0)::int AS questions,
              COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
            FROM date_series ds
            LEFT JOIN daily_chat_sessions dcs ON ds.date = dcs.date
            LEFT JOIN daily_questions dq ON ds.date = dq.date
            ORDER BY ds.date ASC
          `;
        } else if (!startDateIso) {
          // All time, specific group
          timeSeries = await getSqlConnection()`
            WITH date_series AS (
              SELECT generate_series(
                DATE_TRUNC('day', (SELECT MIN(cs.created_at) FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId})),
                DATE_TRUNC('day', NOW()),
                '1 day'::interval
              )::date AS date
            ),
            daily_chat_sessions AS (
              SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users
              FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId}
              GROUP BY 1
            ),
            daily_questions AS (
              SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users
              FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId}
              WHERE cm.sender = 'user' GROUP BY 1
            )
            SELECT TO_CHAR(ds.date, 'Mon DD') AS date,
              COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users,
              COALESCE(dq.questions, 0)::int AS questions,
              COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
            FROM date_series ds
            LEFT JOIN daily_chat_sessions dcs ON ds.date = dcs.date
            LEFT JOIN daily_questions dq ON ds.date = dq.date
            ORDER BY ds.date ASC
          `;
        } else {
          // Date-filtered, specific group
          timeSeries = await getSqlConnection()`
            WITH date_series AS (
              SELECT generate_series(DATE_TRUNC('day', ${startDateIso}::timestamp), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date
            ),
            daily_chat_sessions AS (
              SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users
              FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId}
              WHERE cs.created_at >= ${startDateIso} GROUP BY 1
            ),
            daily_questions AS (
              SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users
              FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${groupId}
              WHERE cm.created_at >= ${startDateIso} AND cm.sender = 'user' GROUP BY 1
            )
            SELECT TO_CHAR(ds.date, 'Mon DD') AS date,
              COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users,
              COALESCE(dq.questions, 0)::int AS questions,
              COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
            FROM date_series ds
            LEFT JOIN daily_chat_sessions dcs ON ds.date = dcs.date
            LEFT JOIN daily_questions dq ON ds.date = dq.date
            ORDER BY ds.date ASC
          `;
        }

        const totals = await fetchTotals();

        response.statusCode = 200;
        response.body = JSON.stringify({ timeSeries, totals });
        break;
      }

      // Fetch latest system settings
      case "GET /admin/system-settings": {
        const rows = await getSqlConnection()`
          WITH latest AS (
            SELECT *
            FROM system_settings
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
          )
          SELECT
            latest.id,
            latest.max_messages_per_day,
            latest.max_characters_per_user_message,
            latest.max_characters_per_ai_message,
            latest.temperature,
            latest.support_score_threshold,
            latest.scope_alignment_score_threshold,
            latest.grounded_threshold,
            latest.partially_grounded_threshold,
            latest.max_context_chunks,
            latest.max_history_messages,
            u.email AS updated_by_email,
            latest.updated_at
          FROM latest
          LEFT JOIN users u ON u.id = latest.updated_by
        `;

        // But keep a safe fallback to avoid crashing UI.
        const fallback = {
          max_messages_per_day: 45,
          max_characters_per_user_message: 2000,
          max_characters_per_ai_message: 5000,
          temperature: 0.2,
          support_score_threshold: 0.25,
          scope_alignment_score_threshold: 0.25,
          grounded_threshold: 0.75,
          partially_grounded_threshold: 0.5,
          max_context_chunks: 10,
          max_history_messages: 20,
          updated_by: null,
          updated_at: null,
        };

        response.statusCode = 200;
        response.body = JSON.stringify(rows[0] ?? fallback);
        break;
      }

      // GET /admin/entra_groups — paginated list of Glue-known groups with member counts
      case "GET /admin/entra_groups": {
        try {
          const qs = event.queryStringParameters ?? {};
          const limit = Math.min(parseInt(qs.limit ?? "20", 10), 50);
          const offset = Math.max(parseInt(qs.offset ?? "0", 10), 0);

          const rows = await getSqlConnection()`
            SELECT
              eg.id,
              eg.display_name,
              COUNT(um.user_id)::int AS member_count
            FROM entra_groups eg
            LEFT JOIN user_memberships um ON um.entra_group_id = eg.id
            GROUP BY eg.id, eg.display_name
            ORDER BY eg.display_name ASC
            LIMIT ${limit} OFFSET ${offset}
          `;

          const [{ total }] = await getSqlConnection()`
            SELECT COUNT(*)::int AS total FROM entra_groups
          `;

          response.statusCode = 200;
          response.body = JSON.stringify({ groups: rows, total, limit, offset });
          break;
        } catch (err) {
          console.error("GET /admin/entra_groups error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // GET /admin/entra_groups/{groupId}/users — paginated users within a group
      case "GET /admin/entra_groups/{groupId}/users": {
        try {
          const groupId = event.pathParameters?.groupId;
          if (!groupId) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "groupId is required" });
            break;
          }

          const qs = event.queryStringParameters ?? {};
          const limit = Math.min(parseInt(qs.limit ?? "10", 10), 50);
          const offset = Math.max(parseInt(qs.offset ?? "0", 10), 0);

          const rows = await getSqlConnection()`
            SELECT
              u.id,
              u.email,
              u.display_name,
              u.last_seen_at
            FROM user_memberships um
            JOIN users u ON u.id = um.user_id
            WHERE um.entra_group_id = ${groupId}
            ORDER BY u.email ASC
            LIMIT ${limit} OFFSET ${offset}
          `;

          const [{ total }] = await getSqlConnection()`
            SELECT COUNT(*)::int AS total
            FROM user_memberships
            WHERE entra_group_id = ${groupId}
          `;

          response.statusCode = 200;
          response.body = JSON.stringify({ users: rows, total, limit, offset });
          break;
        } catch (err) {
          console.error("GET /admin/entra_groups/{groupId}/users error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // GET /admin/entra_groups/unassigned/users — users with no group memberships
      case "GET /admin/entra_groups/unassigned/users": {
        try {
          const qs = event.queryStringParameters ?? {};
          const limit = Math.min(parseInt(qs.limit ?? "10", 10), 50);
          const offset = Math.max(parseInt(qs.offset ?? "0", 10), 0);

          const rows = await getSqlConnection()`
            SELECT u.id, u.email, u.display_name, u.last_seen_at
            FROM users u
            WHERE NOT EXISTS (
              SELECT 1 FROM user_memberships um WHERE um.user_id = u.id
            )
            ORDER BY u.email ASC
            LIMIT ${limit} OFFSET ${offset}
          `;

          const [{ total }] = await getSqlConnection()`
            SELECT COUNT(*)::int AS total
            FROM users u
            WHERE NOT EXISTS (
              SELECT 1 FROM user_memberships um WHERE um.user_id = u.id
            )
          `;

          response.statusCode = 200;
          response.body = JSON.stringify({ users: rows, total, limit, offset });
          break;
        } catch (err) {
          console.error("GET /admin/entra_groups/unassigned/users error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // fetches the list of users for admin to view
      case "GET /admin/users": {
        try {
          const qs = event.queryStringParameters ?? {};
          const limit = Math.min(parseInt(qs.limit ?? "50", 10), 100); // cap limit to 100
          const offset = parseInt(qs.offset ?? "0", 10);

          const rows = await getSqlConnection()`
            SELECT id, email, display_name, created_at, last_seen_at
            FROM users
            ORDER BY COALESCE(last_seen_at, created_at) DESC
            LIMIT ${limit} OFFSET ${offset}
          `;

          response.statusCode = 200;
          response.body = JSON.stringify(rows);
          break;
        } catch (err) {
          console.error("GET /admin/users error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // fetches the chat sessions for a specific user 
      case "GET /admin/users/{userId}/chat_sessions": {
        try {
          const userId = event.pathParameters?.userId;
          if (!userId) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "User ID is required" });
            break;
          }

          const qs = event.queryStringParameters ?? {};
          const limit = parseInt(qs.limit ?? "50", 10);
          const offset = parseInt(qs.offset ?? "0", 10);

          const rows = await getSqlConnection()`
            SELECT id, user_id, title, created_at, last_active_at
            FROM chat_sessions
            WHERE user_id = ${userId}
            ORDER BY COALESCE(last_active_at, created_at) DESC
            LIMIT ${limit} OFFSET ${offset}
          `;

          response.statusCode = 200;
          response.body = JSON.stringify(rows);
          break;
        } catch (err) {
          console.error("GET /admin/users/{userId}/chat_sessions error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // fetches the messages for a specific chat session
      case "GET /admin/chat_sessions/{sessionId}/messages": {
        try {
          const sessionId = event.pathParameters?.sessionId;
          if (!sessionId) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "Session ID is required" });
            break;
          }

          const qs = event.queryStringParameters ?? {};
          const limit = parseInt(qs.limit ?? "200", 10);
          const offset = parseInt(qs.offset ?? "0", 10);

          const rows = await getSqlConnection()`
             SELECT
               m.id,
               m.chat_session_id,
               m.sender,
               m.content,
               m.sources,
               m.created_at,
               r.is_positive AS rating_is_positive,
               r.comment AS rating_comment,
               r.category::text AS rating_category
             FROM chat_messages m
             LEFT JOIN message_ratings r ON r.message_id = m.id
             WHERE m.chat_session_id = ${sessionId}
             ORDER BY m.created_at ASC
             LIMIT ${limit} OFFSET ${offset}
          `;

          const messages = rows.map(({ rating_is_positive, rating_comment, rating_category, ...msg }) => ({
            ...msg,
            rating: rating_is_positive !== null && rating_is_positive !== undefined
              ? { is_positive: rating_is_positive, comment: rating_comment ?? null, category: rating_category ?? null }
              : null,
          }));

          response.statusCode = 200;
          response.body = JSON.stringify(messages);
          break;
        } catch (err) {
          console.error("GET /admin/chat_sessions/{sessionId}/messages error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // Update settings (patch-style)
      case "PUT /admin/system-settings": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const validateOptionalUnitIntervalField = (obj, fieldName) => {
          const value = obj[fieldName];

          if (value === undefined) return null;

          if (!isFiniteNumber(value) || value < 0 || value > 1) {
            return `${fieldName} must be a number between 0 and 1`;
          }

          return null;
        };

        const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
        const isFiniteInt = (v) => Number.isInteger(v) && Number.isFinite(v);

        const allowed = [
          "max_messages_per_day",
          "max_characters_per_user_message",
          "max_characters_per_ai_message",
          "temperature",
          "support_score_threshold",
          "scope_alignment_score_threshold",
          "grounded_threshold",
          "partially_grounded_threshold",
          "max_context_chunks",
          "max_history_messages",
        ];

        const patch = {};
        for (const key of allowed) {
          if (body[key] !== undefined) patch[key] = body[key];
        }

        if (Object.keys(patch).length === 0) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "No valid fields to update" });
          break;
        }

        // validate user
        const adminUserId = getAuthenticatedUserId(event);
        if (!adminUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        console.log(JSON.stringify(buildAuditEntry(adminUserId, "update_system_settings", null, { patch })));

        if (
          patch.max_messages_per_day !== undefined &&
          (!isFiniteInt(patch.max_messages_per_day) ||
            patch.max_messages_per_day < 1 ||
            patch.max_messages_per_day > 1000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_messages_per_day must be an integer between 1 and 1000",
          });
          break;
        }

        if (
          patch.max_context_chunks !== undefined &&
          (!isFiniteInt(patch.max_context_chunks) ||
            patch.max_context_chunks < 1 ||
            patch.max_context_chunks > 50)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_context_chunks must be an integer between 1 and 50",
          });
          break;
        }

        if (
          patch.max_history_messages !== undefined &&
          (!isFiniteInt(patch.max_history_messages) ||
            patch.max_history_messages < 1 ||
            patch.max_history_messages > 100)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_history_messages must be an integer between 1 and 100",
          });
          break;
        }

        if (
          patch.max_characters_per_user_message !== undefined &&
          (!isFiniteInt(patch.max_characters_per_user_message) ||
            patch.max_characters_per_user_message < 1 ||
            patch.max_characters_per_user_message > 200000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_characters_per_user_message must be a positive integer",
          });
          break;
        }

        if (
          patch.max_characters_per_ai_message !== undefined &&
          (!isFiniteInt(patch.max_characters_per_ai_message) ||
            patch.max_characters_per_ai_message < 1 ||
            patch.max_characters_per_ai_message > 200000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_characters_per_ai_message must be a positive integer",
          });
          break;
        }

        if (
          patch.temperature !== undefined &&
          (!isFiniteNumber(patch.temperature) ||
            patch.temperature < 0 ||
            patch.temperature > 2)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "temperature must be a number between 0 and 2",
          });
          break;
        }

        const unitIntervalFields = [
          "top_p",
          "support_score_threshold",
          "scope_alignment_score_threshold",
          "grounded_threshold",
          "partially_grounded_threshold",
        ];

        let unitIntervalError = null;

        for (const field of unitIntervalFields) {
          unitIntervalError = validateOptionalUnitIntervalField(patch, field);
          if (unitIntervalError) break;
        }

        if (unitIntervalError) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: unitIntervalError });
          break;
        }

        // get admin user ID and confirm role
        const updatedByUserId = adminUserId;

        // Single UPDATE of the latest row (no â€œensure row existsâ€ step)
        const updated = await getSqlConnection()`
          WITH latest AS (
            SELECT id
            FROM system_settings
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
          )
          UPDATE system_settings s
          SET
            max_messages_per_day = COALESCE(${patch.max_messages_per_day}, s.max_messages_per_day),
            max_characters_per_user_message = COALESCE(${patch.max_characters_per_user_message}, s.max_characters_per_user_message),
            max_characters_per_ai_message = COALESCE(${patch.max_characters_per_ai_message}, s.max_characters_per_ai_message),
            temperature = COALESCE(${patch.temperature}, s.temperature),
            support_score_threshold = COALESCE(${patch.support_score_threshold}, s.support_score_threshold),
            scope_alignment_score_threshold = COALESCE(${patch.scope_alignment_score_threshold}, s.scope_alignment_score_threshold),
            grounded_threshold = COALESCE(${patch.grounded_threshold}, s.grounded_threshold),
            partially_grounded_threshold = COALESCE(${patch.partially_grounded_threshold}, s.partially_grounded_threshold),
            max_context_chunks = COALESCE(${patch.max_context_chunks}, s.max_context_chunks),
            max_history_messages = COALESCE(${patch.max_history_messages}, s.max_history_messages),
            updated_by = ${updatedByUserId},
            updated_at = NOW()
          WHERE s.id = (SELECT id FROM latest)
          RETURNING
            s.id,
            s.max_messages_per_day,
            s.max_characters_per_user_message,
            s.max_characters_per_ai_message,
            s.temperature,
            s.support_score_threshold,
            s.scope_alignment_score_threshold,
            s.grounded_threshold,
            s.partially_grounded_threshold,
            s.max_context_chunks,
            s.max_history_messages,
            s.updated_by,
            s.updated_at
        `;

        if (updated.length === 0) {
          // Should never happen because we seed system_settings
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "system_settings row not found (seed may not have run)",
          });
          break;
        }

        response.statusCode = 200;
        response.body = JSON.stringify(updated[0]);
        break;
      }

        break;

      // POST /admin/ingestion/trigger — start a Glue ingestion job run
      case "POST /admin/ingestion/trigger": {
        let body = {};
        try { body = parseBody(event.body); } catch (_) {}
        console.log(JSON.stringify(buildAuditEntry(getAuthenticatedUserId(event), "trigger_ingestion")));
        const forceFull = body?.force_full === true ? "true" : "false";
        const jobName = process.env.GLUE_JOB_NAME;
        if (!jobName) {
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "GLUE_JOB_NAME not configured" });
          break;
        }

        // Block if a run is already in-flight (status check against DB)
        const inFlight = await getSqlConnection()`
          SELECT id FROM ingestion_runs
          WHERE run_type = 'site' AND status IN ('running', 'stopping')
          LIMIT 1
        `;
        if (inFlight.length > 0) {
          response.statusCode = 409;
          response.body = JSON.stringify({ error: "An ingestion job is already running." });
          break;
        }

        // Insert the DB row first to get its UUID, then start Glue passing that UUID
        const ingestionAdminRows = [{ id: getAuthenticatedUserId(event) }].filter(r => r.id);
        const metadataJson = {
          force_full: forceFull === "true",
          job_name: jobName,
          ...(ingestionAdminRows[0] ? { triggered_by_user_id: ingestionAdminRows[0].id.toString() } : {}),
        };
        const inserted = await getSqlConnection()`
          INSERT INTO ingestion_runs (run_type, triggered_by, status, started_at, metadata)
          VALUES ('site', 'manual', 'running', now(), ${JSON.stringify(metadataJson)}::jsonb)
          RETURNING id
        `;
        const ingestionRunId = inserted[0].id;

        const glueResp = await glueClient.send(new StartJobRunCommand({
          JobName: jobName,
          Arguments: {
            "--FORCE_FULL": forceFull,
            "--TRIGGERED_BY": "manual",
            "--INGESTION_RUN_ID": ingestionRunId,
          },
        }));
        const glueRunId = glueResp.JobRunId;

        // Store the glue run ID back on the row
        await getSqlConnection()`
          UPDATE ingestion_runs SET glue_run_id = ${glueRunId} WHERE id = ${ingestionRunId}
        `;

        response.body = JSON.stringify({ jobRunId: glueRunId });
        break;
      }

      // POST /admin/ingestion/stop — request cancellation of the active Glue job run
      case "POST /admin/ingestion/stop": {
        console.log(JSON.stringify(buildAuditEntry(getAuthenticatedUserId(event), "stop_ingestion")));
        const jobName = process.env.GLUE_JOB_NAME;
        if (!jobName) {
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "GLUE_JOB_NAME not configured" });
          break;
        }

        const activeRuns = await getSqlConnection()`
          SELECT id, glue_run_id FROM ingestion_runs
          WHERE run_type = 'site' AND status = 'running'
          LIMIT 1
        `;
        if (activeRuns.length === 0) {
          response.statusCode = 409;
          response.body = JSON.stringify({ error: "No running ingestion job to stop." });
          break;
        }

        const { id: runId, glue_run_id: glueRunId } = activeRuns[0];

        if (glueRunId) {
          await glueClient.send(new BatchStopJobRunCommand({
            JobName: jobName,
            JobRunIds: [glueRunId],
          }));
        }

        await getSqlConnection()`
          UPDATE ingestion_runs SET status = 'stopping' WHERE id = ${runId}
        `;

        response.body = JSON.stringify({ stopped: true });
        break;
      }

      // GET /admin/ingestion/runs — recent site-level run history from DB
      case "GET /admin/ingestion/runs": {
        const jobName = process.env.GLUE_JOB_NAME;
        const limit = Math.min(parseInt(event.queryStringParameters?.limit || "5", 10), 50);
        const offset = Math.max(parseInt(event.queryStringParameters?.offset || "0", 10), 0);

        // Reconcile any 'stopping' rows: if Glue reports the run is no longer running, mark stopped
        if (jobName) {
          const stoppingRows = await getSqlConnection()`
            SELECT id, glue_run_id FROM ingestion_runs
            WHERE run_type = 'site' AND status = 'stopping' AND glue_run_id IS NOT NULL
          `;
          for (const row of stoppingRows) {
            try {
              const jr = await glueClient.send(new GetJobRunCommand({ JobName: jobName, RunId: row.glue_run_id }));
              const glueState = jr.JobRun?.JobRunState;
              console.log(`Reconcile stopping run ${row.id}: Glue state=${glueState}`);
              if (glueState && !["RUNNING", "STARTING", "STOPPING"].includes(glueState)) {
                await getSqlConnection()`
                  UPDATE ingestion_runs
                  SET status = 'stopped', finished_at = now()
                  WHERE id = ${row.id}
                `;
              }
            } catch (reconcileErr) {
              console.error(`Failed to reconcile stopping run ${row.id}:`, reconcileErr.message);
            }
          }
        }

        const [{ count: totalCount }] = await getSqlConnection()`
          SELECT COUNT(*) FROM ingestion_runs WHERE run_type = 'site'
        `;

        const runs = await getSqlConnection()`
          SELECT
            id, glue_run_id, run_type, triggered_by, status,
            started_at, finished_at,
            total_documents, processed_documents, ingested_documents,
            skipped_documents, failed_documents, error_message, metadata
          FROM ingestion_runs
          WHERE run_type = 'site'
          ORDER BY started_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
        response.body = JSON.stringify({ runs, total: parseInt(totalCount, 10), limit, offset });
        break;
      }

      // GET /admin/ingestion/logs?jobRunId=xxx&nextToken=yyy&logType=output|error
      case "GET /admin/ingestion/logs": {
        const jobRunId = event.queryStringParameters?.jobRunId;
        const nextToken = event.queryStringParameters?.nextToken;
        const logType = event.queryStringParameters?.logType || "output";
        const jobName = process.env.GLUE_JOB_NAME;
        if (!jobRunId || !jobName) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "jobRunId is required" });
          break;
        }

        // Get job run status
        const jobRunResp = await glueClient.send(new GetJobRunCommand({ JobName: jobName, RunId: jobRunId }));
        const jobRun = jobRunResp.JobRun;
        const status = jobRun?.JobRunState;

        const logGroupName = logType === "error" ? `/aws-glue/python-jobs/error` : `/aws-glue/python-jobs/output`;
        const logStreamPrefix = jobRunId;
        let logLines = [];
        let nextForwardToken = null;

        try {
          const streamsResp = await logsClient.send(new DescribeLogStreamsCommand({
            logGroupName,
            logStreamNamePrefix: logStreamPrefix,
          }));
          console.log("DescribeLogStreams result:", JSON.stringify(streamsResp.logStreams?.map(s => s.logStreamName)));
          const stream = streamsResp.logStreams?.[0];
          if (stream) {
            const logsResp = await logsClient.send(new GetLogEventsCommand({
              logGroupName,
              logStreamName: stream.logStreamName,
              nextToken: nextToken || undefined,
              startFromHead: true,
            }));
            logLines = (logsResp.events || []).map(e => ({ timestamp: e.timestamp, message: e.message }));
            nextForwardToken = logsResp.nextForwardToken;
          }
        } catch (logErr) {
          console.warn("Could not fetch logs:", logErr.message);
        }

        response.body = JSON.stringify({ status, jobRunId, logLines, nextForwardToken, logType });
        break;
      }

      // GET /admin/ingestion/schedule — fetch current EventBridge schedule config
      case "GET /admin/ingestion/schedule": {
        const scheduleName = process.env.SCHEDULE_NAME;
        if (!scheduleName) {
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "SCHEDULE_NAME not configured" });
          break;
        }
        try {
          const result = await schedulerClient.send(new GetScheduleCommand({ Name: scheduleName }));
          const input = result.Target?.Input ? JSON.parse(result.Target.Input) : {};
          const rawExpr = result.ScheduleExpression || "";
          const cron = rawExpr.replace(/^cron\(/, "").replace(/\)$/, "");

          // Fetch last-updated metadata from DB
          const [meta] = await getSqlConnection()`
            SELECT u.email AS updated_by_email, s.updated_at
            FROM ingestion_schedule s
            LEFT JOIN users u ON u.id = s.updated_by
            LIMIT 1
          `;

          response.body = JSON.stringify({
            exists: true,
            cron,
            timezone: result.ScheduleExpressionTimezone || "UTC",
            enabled: result.State === "ENABLED",
            force_full: input.force_full === true,
            next_run_at: result.NextInvocationTime ? result.NextInvocationTime.toISOString() : null,
            updated_by_email: meta?.updated_by_email ?? null,
            updated_at: meta?.updated_at ?? null,
          });
        } catch (err) {
          if (err.name === "ResourceNotFoundException") {
            response.body = JSON.stringify({ exists: false });
          } else {
            throw err;
          }
        }
        break;
      }

      // PUT /admin/ingestion/schedule — create or update the EventBridge schedule
      case "PUT /admin/ingestion/schedule": {
        const scheduleName = process.env.SCHEDULE_NAME;
        const executionRoleArn = process.env.SCHEDULER_EXECUTION_ROLE_ARN;
        const lambdaArn = process.env.ADMIN_LAMBDA_ARN;
        if (!scheduleName || !executionRoleArn || !lambdaArn) {
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Scheduler env vars not configured" });
          break;
        }
        let body = {};
        try { body = parseBody(event.body); } catch (_) {}
        const { cron, timezone, enabled, force_full } = body;
        if (!cron || !timezone) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "cron and timezone are required" });
          break;
        }
        console.log(JSON.stringify(buildAuditEntry(getAuthenticatedUserId(event), "update_ingestion_schedule", null, { cron, timezone, enabled, force_full })));

        const scheduleParams = {
          Name: scheduleName,
          ScheduleExpression: `cron(${cron})`,
          ScheduleExpressionTimezone: timezone,
          State: enabled === false ? "DISABLED" : "ENABLED",
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: {
            Arn: lambdaArn,
            RoleArn: executionRoleArn,
            Input: JSON.stringify({ force_full: force_full === true }),
          },
        };

        // Try update first, fall back to create
        let existed = true;
        try {
          await schedulerClient.send(new UpdateScheduleCommand(scheduleParams));
        } catch (err) {
          if (err.name === "ResourceNotFoundException") {
            existed = false;
            await schedulerClient.send(new CreateScheduleCommand(scheduleParams));
          } else {
            throw err;
          }
        }

        const updatedByUserId = getAuthenticatedUserId(event);

        // Upsert single row in ingestion_schedule
        await getSqlConnection()`
          INSERT INTO ingestion_schedule (cron, timezone, enabled, force_full, updated_by, updated_at)
          VALUES (${cron}, ${timezone}, ${enabled !== false}, ${force_full === true}, ${updatedByUserId}, now())
          ON CONFLICT DO NOTHING
        `;
        await getSqlConnection()`
          UPDATE ingestion_schedule
          SET cron = ${cron}, timezone = ${timezone}, enabled = ${enabled !== false},
              force_full = ${force_full === true}, updated_by = ${updatedByUserId}, updated_at = now()
        `;

        // Fetch back to return next_run_at
        const updated = await schedulerClient.send(new GetScheduleCommand({ Name: scheduleName }));
        response.body = JSON.stringify({
          created: !existed,
          updated: existed,
          next_run_at: updated.NextInvocationTime ? updated.NextInvocationTime.toISOString() : null,
        });
        break;
      }

      // DELETE /admin/ingestion/schedule — remove the EventBridge schedule
      case "DELETE /admin/ingestion/schedule": {
        console.log(JSON.stringify(buildAuditEntry(getAuthenticatedUserId(event), "delete_ingestion_schedule")));
        const scheduleName = process.env.SCHEDULE_NAME;
        if (!scheduleName) {
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "SCHEDULE_NAME not configured" });
          break;
        }
        try {
          await schedulerClient.send(new DeleteScheduleCommand({ Name: scheduleName }));
          await getSqlConnection()`DELETE FROM ingestion_schedule`;
          response.body = JSON.stringify({ deleted: true });
        } catch (err) {
          if (err.name === "ResourceNotFoundException") {
            response.statusCode = 404;
            response.body = JSON.stringify({ error: "No schedule exists to delete" });
          } else {
            throw err;
          }
        }
        break;
      }

      // POST /admin/export/trigger — enqueue a new export job
      case "POST /admin/export/trigger": {
        let body = {};
        try { body = parseBody(event.body); } catch (_) {}

        const scope = body?.scope;
        console.log(JSON.stringify(buildAuditEntry(getAuthenticatedUserId(event), "trigger_export", null, { scope, scope_id: body?.scope_id ?? null })));
        if (!['all', 'group', 'user', 'analytics'].includes(scope)) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "scope must be 'all', 'group', 'user', or 'analytics'" });
          break;
        }
        if ((scope === 'group' || scope === 'user') && !body?.scope_id) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "scope_id is required when scope is 'group' or 'user'" });
          break;
        }

        const exportAdminUserId = getAuthenticatedUserId(event);
        if (!exportAdminUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        const exportMetadata = scope === 'analytics'
          ? { groupId: body?.groupId ?? null, timeRange: body?.timeRange ?? null }
          : null;

        const exportTypeValue = scope === 'analytics' ? 'analytics' : 'chat';

        const inserted = await getSqlConnection()`
          INSERT INTO export_runs (requested_by, status, scope, scope_id, metadata, export_type)
          VALUES (${exportAdminUserId}::uuid, 'pending', ${scope}::export_scope, ${body?.scope_id ?? null}::uuid, ${exportMetadata}::jsonb, ${exportTypeValue}::export_type)
          RETURNING id::text
        `;
        const exportRunId = inserted[0].id;

        await sqsClient.send(new SendMessageCommand({
          QueueUrl: process.env.EXPORT_QUEUE_URL,
          MessageBody: JSON.stringify({ exportRunId }),
        }));

        await getSqlConnection()`
          UPDATE export_runs SET status = 'processing' WHERE id = ${exportRunId}
        `;

        response.statusCode = 202;
        response.body = JSON.stringify({ exportRunId });
        break;
      }

      // GET /admin/export/runs — list export jobs for the current admin
      case "GET /admin/export/runs": {
        const adminUserId = getAuthenticatedUserId(event);
        if (!adminUserId) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        const qs = event.queryStringParameters ?? {};
        const limit = 10;
        const offset = Math.max(parseInt(qs.offset ?? '0', 10), 0);
        const exportTypeFilter = ['chat', 'analytics'].includes(qs.export_type) ? qs.export_type : null;

        const rawRuns = await getSqlConnection()`
          SELECT
            er.id,
            er.status,
            er.scope,
            er.export_type,
            er.metadata,
            er.s3_key,
            er.error_message,
            er.requested_at,
            er.completed_at,
            CASE
              WHEN er.scope::text = 'group' THEN eg.display_name
              WHEN er.scope::text = 'user'  THEN u2.email
              ELSE NULL
            END AS _scope_base,
            CASE
              WHEN er.scope::text = 'analytics' AND jsonb_typeof(er.metadata->'groupId') = 'array' THEN (
                SELECT STRING_AGG(eg2.display_name, ', ' ORDER BY eg2.display_name)
                FROM jsonb_array_elements_text(er.metadata->'groupId') AS gid
                JOIN entra_groups eg2 ON eg2.id::text = gid
              )
              WHEN er.scope::text = 'analytics' THEN eg_meta.display_name
              ELSE NULL
            END AS _meta_group_name
          FROM export_runs er
          LEFT JOIN entra_groups eg      ON eg.id = er.scope_id::text AND er.scope::text = 'group'
          LEFT JOIN users u2             ON u2.id = er.scope_id AND er.scope::text = 'user'
          LEFT JOIN entra_groups eg_meta ON eg_meta.id::text = (er.metadata->>'groupId') AND er.scope::text = 'analytics' AND jsonb_typeof(er.metadata->'groupId') = 'string'
          WHERE er.requested_by = ${adminUserId}
          ${exportTypeFilter ? getSqlConnection()`AND er.export_type = ${exportTypeFilter}::export_type` : getSqlConnection()``}
          ORDER BY er.requested_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;

        const runs = await Promise.all(rawRuns.map(async (r) => {
          const meta = (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) ?? {};
          let scope_label;
          if (r.scope === 'analytics') {
            const groupPart = r._meta_group_name ?? 'All groups';
            const timePart = meta.timeRange === 'all' ? 'All time'
              : meta.timeRange ? `Last ${meta.timeRange}` : null;
            scope_label = [groupPart, timePart].filter(Boolean).join(' · ');
          } else if (r.scope === 'all') {
            scope_label = 'All chats';
          } else {
            scope_label = r._scope_base ?? r.scope;
          }
          const { _scope_base, _meta_group_name, metadata, s3_key, ...rest } = r;

          let presigned_url = null;
          if (r.status === 'completed' && s3_key) {
            presigned_url = await getSignedUrl(
              s3Client,
              new GetObjectCommand({ Bucket: process.env.EXPORT_BUCKET_NAME, Key: s3_key }),
              { expiresIn: PRESIGN_TTL }
            );
          }

          return { ...rest, scope_label, presigned_url };
        }));

        const [{ total }] = await getSqlConnection()`
          SELECT COUNT(*)::int AS total FROM export_runs
          WHERE requested_by = ${adminUserId}
          ${exportTypeFilter ? getSqlConnection()`AND export_type = ${exportTypeFilter}::export_type` : getSqlConnection()``}
        `;

        response.statusCode = 200;
        response.body = JSON.stringify({ runs, total, limit, offset });
        break;
      }

      // GET /admin/notifications — list notifications for the current admin
      case "GET /admin/notifications": {
        const notifUserId = getAuthenticatedUserId(event);
        if (!notifUserId) { response.statusCode = 401; response.body = JSON.stringify({ error: "Unauthorized" }); break; }

        const notifications = await getSqlConnection()`
          SELECT id::text, type::text, title, message, metadata, created_at
          FROM notifications
          WHERE user_id::text = ${notifUserId}
          ORDER BY created_at DESC
          LIMIT 20
        `;
        const [{ total: notifTotal }] = await getSqlConnection()`
          SELECT COUNT(*)::int AS total FROM notifications WHERE user_id::text = ${notifUserId}
        `;
        response.statusCode = 200;
        response.body = JSON.stringify({ notifications, total: notifTotal });
        break;
      }

      // DELETE /admin/notifications — clear all notifications for the current admin
      case "DELETE /admin/notifications": {
        const clearUserId = getAuthenticatedUserId(event);
        if (!clearUserId) { response.statusCode = 401; response.body = JSON.stringify({ error: "Unauthorized" }); break; }

        await getSqlConnection()`DELETE FROM notifications WHERE user_id::text = ${clearUserId}`;
        response.statusCode = 200;
        response.body = JSON.stringify({ success: true });
        break;
      }

      // DELETE /admin/notifications/{notification_id} — dismiss a single notification
      case "DELETE /admin/notifications/{notification_id}": {
        const dismissUserId = getAuthenticatedUserId(event);
        if (!dismissUserId) { response.statusCode = 401; response.body = JSON.stringify({ error: "Unauthorized" }); break; }

        const notificationId = event.pathParameters?.notification_id;
        if (!notificationId) { response.statusCode = 400; response.body = JSON.stringify({ error: "notification_id required" }); break; }

        const deleted = await getSqlConnection()`
          DELETE FROM notifications
          WHERE id::text = ${notificationId} AND user_id::text = ${dismissUserId}
          RETURNING id::text
        `;
        if (!deleted.length) { response.statusCode = 404; response.body = JSON.stringify({ error: "Notification not found" }); break; }
        response.statusCode = 200;
        response.body = JSON.stringify({ success: true });
        break;
      }

      // GET /admin/feedback — paginated list of dislike ratings with context
      case "GET /admin/feedback": {
        try {
          const feedbackQs = event.queryStringParameters ?? {};
          const feedbackFrom = feedbackQs.from || null;
          const feedbackTo = feedbackQs.to || null;
          const feedbackLimit = Math.min(parseInt(feedbackQs.limit ?? "5", 10), 200);
          const feedbackOffset = parseInt(feedbackQs.offset ?? "0", 10);
          const VALID_CATEGORIES = ["Not helpful", "Inaccurate", "Off-topic", "Other"];
          const feedbackCategory = feedbackQs.category && VALID_CATEGORIES.includes(feedbackQs.category)
            ? feedbackQs.category
            : null;

          const feedbackRows = await getSqlConnection()`
            SELECT
              mr.id::text,
              mr.is_positive,
              mr.comment,
              mr.category::text AS category,
              mr.created_at,
              ai_msg.id::text AS message_id,
              LEFT(ai_msg.content, 300) AS ai_response,
              ai_msg.chat_session_id::text,
              user_msg.content AS user_question,
              u.email AS user_email,
              u.display_name AS user_display_name,
              COUNT(*) OVER() AS total_count
            FROM message_ratings mr
            JOIN chat_messages ai_msg ON ai_msg.id = mr.message_id
            LEFT JOIN LATERAL (
              SELECT content FROM chat_messages
              WHERE chat_session_id = ai_msg.chat_session_id
                AND sender = 'user'
                AND created_at < ai_msg.created_at
              ORDER BY created_at DESC
              LIMIT 1
            ) user_msg ON true
            LEFT JOIN chat_sessions cs ON cs.id = ai_msg.chat_session_id
            LEFT JOIN users u ON u.id = cs.user_id
            WHERE mr.is_positive = false
              AND (${feedbackFrom}::timestamptz IS NULL OR mr.created_at >= ${feedbackFrom}::timestamptz)
              AND (${feedbackTo}::timestamptz IS NULL OR mr.created_at <= ${feedbackTo}::timestamptz)
              AND (${feedbackCategory}::feedback_category IS NULL OR mr.category = ${feedbackCategory}::feedback_category)
            ORDER BY mr.created_at DESC
            LIMIT ${feedbackLimit} OFFSET ${feedbackOffset}
          `;

          const total = feedbackRows.length > 0 ? parseInt(feedbackRows[0].total_count) : 0;
          const feedback = feedbackRows.map(({ total_count, ...row }) => row);

          response.statusCode = 200;
          response.body = JSON.stringify({ feedback, total, limit: feedbackLimit, offset: feedbackOffset });
        } catch (err) {
          console.error("GET /admin/feedback error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
        }
        break;
      }

      // GET /admin/feedback/summary — daily likes+dislikes trend and per-category counts
      case "GET /admin/feedback/summary": {
        try {
          const summaryQs = event.queryStringParameters ?? {};
          const summaryFrom = summaryQs.from || null;
          const summaryTo = summaryQs.to || null;

          const dislikeTrend = await getSqlConnection()`
            SELECT date_trunc('day', mr.created_at)::date::text AS day, COUNT(*)::int AS count
            FROM message_ratings mr
            WHERE mr.is_positive = false
              AND (${summaryFrom}::timestamptz IS NULL OR mr.created_at >= ${summaryFrom}::timestamptz)
              AND (${summaryTo}::timestamptz IS NULL OR mr.created_at <= ${summaryTo}::timestamptz)
            GROUP BY 1 ORDER BY 1
          `;

          const likeTrend = await getSqlConnection()`
            SELECT date_trunc('day', mr.created_at)::date::text AS day, COUNT(*)::int AS count
            FROM message_ratings mr
            WHERE mr.is_positive = true
              AND (${summaryFrom}::timestamptz IS NULL OR mr.created_at >= ${summaryFrom}::timestamptz)
              AND (${summaryTo}::timestamptz IS NULL OR mr.created_at <= ${summaryTo}::timestamptz)
            GROUP BY 1 ORDER BY 1
          `;

          // Merge likes and dislikes into a single array keyed by day
          const dayMap = {};
          dislikeTrend.forEach(r => { dayMap[r.day] = { day: r.day, dislikes: r.count, likes: 0 }; });
          likeTrend.forEach(r => {
            if (dayMap[r.day]) dayMap[r.day].likes = r.count;
            else dayMap[r.day] = { day: r.day, dislikes: 0, likes: r.count };
          });
          const trend = Object.values(dayMap).sort((a, b) => a.day.localeCompare(b.day));

          const categoryCounts = await getSqlConnection()`
            SELECT
              mr.category::text AS category,
              COUNT(*)::int AS count
            FROM message_ratings mr
            WHERE mr.is_positive = false
              AND (${summaryFrom}::timestamptz IS NULL OR mr.created_at >= ${summaryFrom}::timestamptz)
              AND (${summaryTo}::timestamptz IS NULL OR mr.created_at <= ${summaryTo}::timestamptz)
            GROUP BY 1
          `;

          const totalLikes = await getSqlConnection()`
            SELECT COUNT(*)::int AS count FROM message_ratings mr
            WHERE mr.is_positive = true
              AND (${summaryFrom}::timestamptz IS NULL OR mr.created_at >= ${summaryFrom}::timestamptz)
              AND (${summaryTo}::timestamptz IS NULL OR mr.created_at <= ${summaryTo}::timestamptz)
          `;

          const totalDislikes = await getSqlConnection()`
            SELECT COUNT(*)::int AS count FROM message_ratings mr
            WHERE mr.is_positive = false
              AND (${summaryFrom}::timestamptz IS NULL OR mr.created_at >= ${summaryFrom}::timestamptz)
              AND (${summaryTo}::timestamptz IS NULL OR mr.created_at <= ${summaryTo}::timestamptz)
          `;

          response.statusCode = 200;
          response.body = JSON.stringify({
            trend,
            categories: categoryCounts,
            totalLikes: totalLikes[0].count,
            totalDislikes: totalDislikes[0].count,
          });
        } catch (err) {
          console.error("GET /admin/feedback/summary error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
        }
        break;
      }

      // Handle unsupported routes
      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    // Handle specific PostgreSQL error codes
    if (error.code === "23505") {
      // Unique constraint violation (duplicate email)
      response.statusCode = 409; // Conflict
      response.body = JSON.stringify({ error: "Email already exists" });
    } else if (error.code === "23502") {
      // Not null constraint violation
      response.statusCode = 400; // Bad Request
      response.body = JSON.stringify({ error: "Required field is missing" });
    } else {
      // Generic server error for other exceptions
      handleError(error, response);
    }
  }

  return response;
};
