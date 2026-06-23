const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const postgres = require("postgres");
const { writeNotification, writeNotificationToAllAdmins } = require("./utils/notificationWriter");

const secretsManager = new SecretsManagerClient();

const GLUE_TO_DB_STATUS = {
  SUCCEEDED: "completed",
  FAILED: "failed",
  STOPPED: "failed",
  TIMEOUT: "failed",
  ERROR: "failed",
};

let sqlConnection;

const initConnection = async () => {
  if (!sqlConnection) {
    const secret = await secretsManager.send(new GetSecretValueCommand({
      SecretId: process.env.SM_DB_CREDENTIALS,
    }));
    const credentials = JSON.parse(secret.SecretString);
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

  const glueRunId = event?.detail?.jobRunId;
  const glueState = event?.detail?.state;

  if (!glueRunId || !glueState) {
    console.error("[GlueStatusSync] Missing jobRunId or state in event", JSON.stringify(event));
    return;
  }

  const dbStatus = GLUE_TO_DB_STATUS[glueState];
  if (!dbStatus) {
    console.log(`[GlueStatusSync] Ignoring non-terminal state: ${glueState}`);
    return;
  }

  const rows = await sqlConnection`
    SELECT id, metadata
    FROM ingestion_runs
    WHERE glue_run_id = ${glueRunId}
    LIMIT 1
  `;

  if (!rows.length) {
    console.warn(`[GlueStatusSync] No ingestion_run found for glue_run_id=${glueRunId}`);
    return;
  }

  const row = rows[0];

  await sqlConnection`
    UPDATE ingestion_runs
    SET status = ${dbStatus}, finished_at = now()
    WHERE id = ${row.id}
  `;

  console.log(`[GlueStatusSync] Run ${glueRunId} → ${dbStatus}`);

  const isCompleted = dbStatus === "completed";
  const triggeredByUserId = row.metadata?.triggered_by_user_id;

  try {
    if (triggeredByUserId) {
      await writeNotification(sqlConnection, {
        userId: triggeredByUserId,
        type: isCompleted ? "ingestion_completed" : "ingestion_failed",
        title: isCompleted ? "Ingestion complete" : "Ingestion failed",
        message: isCompleted
          ? "SharePoint ingestion finished successfully."
          : `Ingestion ended with status "${dbStatus}".`,
        metadata: { ingestion_run_id: row.id.toString() },
      });
    } else {
      await writeNotificationToAllAdmins(sqlConnection, {
        type: isCompleted ? "ingestion_completed" : "ingestion_failed",
        title: isCompleted ? "Ingestion complete" : "Ingestion failed",
        message: isCompleted
          ? "Scheduled SharePoint ingestion finished successfully."
          : `Scheduled ingestion ended with status "${dbStatus}".`,
        metadata: { ingestion_run_id: row.id.toString() },
      });
    }
  } catch (notifyErr) {
    console.error(`[GlueStatusSync] Failed to write notification for run ${row.id}:`, notifyErr);
  }
};
