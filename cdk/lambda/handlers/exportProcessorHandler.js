const postgres = require("postgres");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { publishNotification } = require("./utils/publishNotification");

const s3Client = new S3Client({});
const secretsManager = new SecretsManagerClient({});

let sqlConnection;

const initConnection = async () => {
  if (!sqlConnection) {
    const secretResponse = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: process.env.SM_DB_CREDENTIALS })
    );
    const credentials = JSON.parse(secretResponse.SecretString);
    sqlConnection = postgres({
      host: process.env.RDS_PROXY_ENDPOINT,
      port: credentials.port,
      username: credentials.username,
      password: credentials.password,
      database: credentials.dbname,
      ssl: { rejectUnauthorized: true },
    });
    await sqlConnection`SELECT 1`;
  }
};

exports.handler = async (event) => {
  await initConnection();

  const failures = [];

  for (const record of event.Records) {
    let exportRunId;
    try {
      ({ exportRunId } = JSON.parse(record.body));
      console.log(`Processing exportRunId=${exportRunId}`);

      const [run] = await sqlConnection`
        SELECT id, scope, scope_id, metadata, requested_by
        FROM export_runs
        WHERE id = ${exportRunId}
        LIMIT 1
      `;
      if (!run) throw new Error(`export_runs row not found: ${exportRunId}`);

      await sqlConnection`
        UPDATE export_runs SET status = 'processing' WHERE id = ${exportRunId}
      `;

      // Fetch sessions with their messages and ratings
      let sessions;
      if (run.scope === 'all') {
        sessions = await sqlConnection`
          SELECT
            cs.id           AS session_id,
            cs.title,
            cs.created_at,
            cs.last_active_at,
            u.email         AS user_email,
            u.display_name  AS user_display_name,
            COALESCE(
              ARRAY_AGG(DISTINCT eg.display_name) FILTER (WHERE eg.display_name IS NOT NULL),
              ARRAY[]::text[]
            ) AS groups
          FROM chat_sessions cs
          JOIN users u ON u.id = cs.user_id
          LEFT JOIN user_memberships um ON um.user_id = u.id
          LEFT JOIN entra_groups eg ON eg.id = um.entra_group_id
          GROUP BY cs.id, u.email, u.display_name
          ORDER BY cs.created_at ASC
        `;
      } else if (run.scope === 'group') {
        sessions = await sqlConnection`
          SELECT
            cs.id           AS session_id,
            cs.title,
            cs.created_at,
            cs.last_active_at,
            u.email         AS user_email,
            u.display_name  AS user_display_name,
            ARRAY[eg_target.display_name] AS groups
          FROM chat_sessions cs
          JOIN users u ON u.id = cs.user_id
          JOIN user_memberships um ON um.user_id = u.id
          JOIN entra_groups eg_target ON eg_target.id = um.entra_group_id AND eg_target.id = ${run.scope_id}
          ORDER BY cs.created_at ASC
        `;
      } else if (run.scope === 'user') {
        sessions = await sqlConnection`
          SELECT
            cs.id           AS session_id,
            cs.title,
            cs.created_at,
            cs.last_active_at,
            u.email         AS user_email,
            u.display_name  AS user_display_name,
            COALESCE(
              ARRAY_AGG(DISTINCT eg.display_name) FILTER (WHERE eg.display_name IS NOT NULL),
              ARRAY[]::text[]
            ) AS groups
          FROM chat_sessions cs
          JOIN users u ON u.id = cs.user_id AND u.id = ${run.scope_id}
          LEFT JOIN user_memberships um ON um.user_id = u.id
          LEFT JOIN entra_groups eg ON eg.id = um.entra_group_id
          GROUP BY cs.id, u.email, u.display_name
          ORDER BY cs.created_at ASC
        `;
      }

      // -----------------------------------------------------------------------
      // Analytics CSV export
      // -----------------------------------------------------------------------
      if (run.scope === 'analytics') {
        const meta = typeof run.metadata === 'string' ? JSON.parse(run.metadata) : (run.metadata ?? {});
        const groupId = meta.groupId && meta.groupId !== 'all' ? meta.groupId : null;
        const timeRangeParam = meta.timeRange ?? null;
        const isAllTime = timeRangeParam === 'all' || !timeRangeParam;

        let startDateIso = null;
        if (!isAllTime) {
          let daysBack = 90;
          const m = String(timeRangeParam).match(/^(\d+)([dmy])$/);
          if (m) {
            const value = parseInt(m[1], 10);
            const unit = m[2];
            if (unit === 'd') daysBack = value;
            if (unit === 'm') daysBack = value * 30;
            if (unit === 'y') daysBack = value * 365;
          }
          daysBack = Math.min(Math.max(1, daysBack), 365);
          const startDate = new Date();
          startDate.setDate(startDate.getDate() - daysBack);
          startDateIso = startDate.toISOString();
        }

        // Determine which groups to export
        let groupsToExport;
        if (groupId) {
          const [grp] = await sqlConnection`SELECT id, display_name FROM entra_groups WHERE id = ${groupId} LIMIT 1`;
          groupsToExport = grp ? [grp] : [];
        } else {
          groupsToExport = await sqlConnection`SELECT id, display_name FROM entra_groups ORDER BY display_name ASC`;
          // Also include an "All" aggregate
          groupsToExport = [{ id: null, display_name: 'All' }, ...groupsToExport];
        }

        const csvRows = ['date,group,users,chat_sessions,questions'];

        for (const grp of groupsToExport) {
          let rows;
          if (!grp.id && !startDateIso) {
            rows = await sqlConnection`
              WITH date_series AS (
                SELECT generate_series(DATE_TRUNC('day', (SELECT MIN(created_at) FROM chat_sessions)), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date
              ),
              dcs AS (SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users FROM chat_sessions cs GROUP BY 1),
              dq  AS (SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id WHERE cm.sender = 'user' GROUP BY 1)
              SELECT TO_CHAR(ds.date, 'YYYY-MM-DD') AS date, COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users, COALESCE(dq.questions, 0)::int AS questions, COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
              FROM date_series ds LEFT JOIN dcs ON ds.date = dcs.date LEFT JOIN dq ON ds.date = dq.date ORDER BY ds.date ASC
            `;
          } else if (!grp.id) {
            rows = await sqlConnection`
              WITH date_series AS (SELECT generate_series(DATE_TRUNC('day', ${startDateIso}::timestamp), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date),
              dcs AS (SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users FROM chat_sessions cs WHERE cs.created_at >= ${startDateIso} GROUP BY 1),
              dq  AS (SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id WHERE cm.created_at >= ${startDateIso} AND cm.sender = 'user' GROUP BY 1)
              SELECT TO_CHAR(ds.date, 'YYYY-MM-DD') AS date, COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users, COALESCE(dq.questions, 0)::int AS questions, COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
              FROM date_series ds LEFT JOIN dcs ON ds.date = dcs.date LEFT JOIN dq ON ds.date = dq.date ORDER BY ds.date ASC
            `;
          } else if (!startDateIso) {
            rows = await sqlConnection`
              WITH date_series AS (SELECT generate_series(DATE_TRUNC('day', (SELECT MIN(cs.created_at) FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id})), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date),
              dcs AS (SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id} GROUP BY 1),
              dq  AS (SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id} WHERE cm.sender = 'user' GROUP BY 1)
              SELECT TO_CHAR(ds.date, 'YYYY-MM-DD') AS date, COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users, COALESCE(dq.questions, 0)::int AS questions, COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
              FROM date_series ds LEFT JOIN dcs ON ds.date = dcs.date LEFT JOIN dq ON ds.date = dq.date ORDER BY ds.date ASC
            `;
          } else {
            rows = await sqlConnection`
              WITH date_series AS (SELECT generate_series(DATE_TRUNC('day', ${startDateIso}::timestamp), DATE_TRUNC('day', NOW()), '1 day'::interval)::date AS date),
              dcs AS (SELECT DATE_TRUNC('day', cs.created_at)::date AS date, COUNT(cs.id)::int AS chat_sessions, COUNT(DISTINCT cs.user_id)::int AS session_users FROM chat_sessions cs JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id} WHERE cs.created_at >= ${startDateIso} GROUP BY 1),
              dq  AS (SELECT DATE_TRUNC('day', cm.created_at)::date AS date, COUNT(cm.id)::int AS questions, COUNT(DISTINCT cs.user_id)::int AS question_users FROM chat_messages cm JOIN chat_sessions cs ON cs.id = cm.chat_session_id JOIN user_memberships um ON um.user_id = cs.user_id AND um.entra_group_id = ${grp.id} WHERE cm.created_at >= ${startDateIso} AND cm.sender = 'user' GROUP BY 1)
              SELECT TO_CHAR(ds.date, 'YYYY-MM-DD') AS date, COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users, COALESCE(dq.questions, 0)::int AS questions, COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
              FROM date_series ds LEFT JOIN dcs ON ds.date = dcs.date LEFT JOIN dq ON ds.date = dq.date ORDER BY ds.date ASC
            `;
          }
          const groupLabel = grp.display_name.replace(/"/g, '""');
          for (const r of rows) {
            csvRows.push(`${r.date},"${groupLabel}",${r.users},${r.chat_sessions},${r.questions}`);
          }
        }

        const csvContent = csvRows.join('\n');
        const analyticsScope = groupId
          ? (groupsToExport[0]?.display_name ?? 'group')
          : 'all-groups';
        const s3Key = `exports/analytics/${exportRunId}.csv`;

        await s3Client.send(new PutObjectCommand({
          Bucket: process.env.EXPORT_BUCKET_NAME,
          Key: s3Key,
          Body: csvContent,
          ContentType: 'text/csv',
          ContentDisposition: `attachment; filename="analytics-${analyticsScope}-${exportRunId}.csv"`,
        }));

        const presignedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket: process.env.EXPORT_BUCKET_NAME, Key: s3Key }),
          { expiresIn: 604800 }
        );
        const urlExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const rowCount = csvRows.length - 1; // exclude header

        await sqlConnection`
          UPDATE export_runs SET status = 'completed', s3_key = ${s3Key}, presigned_url = ${presignedUrl}, url_expires_at = ${urlExpiresAt}, row_count = ${rowCount}, completed_at = now()
          WHERE id = ${exportRunId}
        `;
        console.log(`Analytics export ${exportRunId} completed: ${rowCount} rows`);

        const exportScopeLabel = groupId ? (groupsToExport[0]?.display_name ?? 'group') : 'All Groups';
        try {
          await publishNotification({
            userId: run.requested_by.toString(),
            type: 'export_completed',
            title: 'Analytics export ready',
            message: `Your analytics CSV export (${exportScopeLabel}) is ready — ${rowCount} rows.`,
            metadata: { export_run_id: exportRunId, presigned_url: presignedUrl, scope_label: exportScopeLabel },
          });
        } catch (notifyErr) {
          console.error('Failed to publish export_completed notification:', notifyErr);
        }
        continue;
      }

      // -----------------------------------------------------------------------
      // Determine scope_label for the export metadata
      let scopeLabel = 'All Chats';
      if (run.scope === 'group' && sessions.length > 0) {
        scopeLabel = sessions[0].groups[0] || 'Unknown Group';
      } else if (run.scope === 'user' && sessions.length > 0) {
        scopeLabel = sessions[0].user_email || 'Unknown User';
      }

      // Fetch messages + ratings for each session
      let totalMessages = 0;
      const sessionObjects = [];

      for (const session of sessions) {
        const messages = await sqlConnection`
          SELECT
            cm.id           AS message_id,
            cm.sender,
            cm.content,
            cm.sources,
            cm.created_at,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT(
                  'is_positive', mr.is_positive,
                  'category', mr.category,
                  'comment', mr.comment,
                  'rated_by', ru.email,
                  'created_at', mr.created_at
                )
              ) FILTER (WHERE mr.id IS NOT NULL),
              '[]'::json
            ) AS ratings
          FROM chat_messages cm
          LEFT JOIN message_ratings mr ON mr.message_id = cm.id
          LEFT JOIN users ru ON ru.id = mr.user_id
          WHERE cm.chat_session_id = ${session.session_id}
          GROUP BY cm.id
          ORDER BY cm.created_at ASC
        `;

        totalMessages += messages.length;
        sessionObjects.push({
          session_id: session.session_id,
          user_email: session.user_email,
          user_display_name: session.user_display_name,
          groups: session.groups,
          title: session.title,
          created_at: session.created_at,
          last_active_at: session.last_active_at,
          messages: messages.map((m) => ({
            message_id: m.message_id,
            sender: m.sender,
            content: m.content,
            sources: m.sources,
            created_at: m.created_at,
            ratings: m.ratings,
          })),
        });
      }

      const exportPayload = {
        exported_at: new Date().toISOString(),
        scope: run.scope,
        scope_label: scopeLabel,
        total_sessions: sessions.length,
        total_messages: totalMessages,
        sessions: sessionObjects,
      };

      const s3Key = `exports/chat/${exportRunId}.json`;
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.EXPORT_BUCKET_NAME,
        Key: s3Key,
        Body: JSON.stringify(exportPayload, null, 2),
        ContentType: 'application/json',
        ContentDisposition: `attachment; filename="export-${exportRunId}.json"`,
      }));

      const presignedUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: process.env.EXPORT_BUCKET_NAME,
          Key: s3Key,
        }),
        { expiresIn: 604800 } // 7 days
      );

      const urlExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      await sqlConnection`
        UPDATE export_runs
        SET
          status         = 'completed',
          s3_key         = ${s3Key},
          presigned_url  = ${presignedUrl},
          url_expires_at = ${urlExpiresAt},
          row_count      = ${totalMessages},
          completed_at   = now()
        WHERE id = ${exportRunId}
      `;
      console.log(`Export ${exportRunId} completed: ${sessions.length} sessions, ${totalMessages} messages`);

      try {
        await publishNotification({
          userId: run.requested_by.toString(),
          type: 'export_completed',
          title: 'Export ready',
          message: `Your "${scopeLabel}" export is complete — ${sessions.length} sessions, ${totalMessages} messages.`,
          metadata: { export_run_id: exportRunId, presigned_url: presignedUrl, scope_label: scopeLabel },
        });
      } catch (notifyErr) {
        console.error('Failed to publish export_completed notification:', notifyErr);
      }

    } catch (err) {
      console.error(`Export ${exportRunId} failed:`, err);
      try {
        await sqlConnection`
          UPDATE export_runs
          SET status = 'failed', error_message = ${err.message}, completed_at = now()
          WHERE id = ${exportRunId}
        `;
      } catch (dbErr) {
        console.error('Failed to update error status:', dbErr);
      }
      if (run?.requested_by) {
        try {
          await publishNotification({
            userId: run.requested_by.toString(),
            type: 'export_failed',
            title: 'Export failed',
            message: `Your "${run.scope}" export could not be completed: ${err.message}`,
            metadata: { export_run_id: exportRunId },
          });
        } catch (notifyErr) {
          console.error('Failed to publish export_failed notification:', notifyErr);
        }
      }
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
