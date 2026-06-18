const { GlueClient, GetJobRunCommand } = require("@aws-sdk/client-glue");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const postgres = require("postgres");
const { writeNotification, writeNotificationToAllAdmins } = require("./utils/notificationWriter");

const glueClient = new GlueClient({});
const secretsManager = new SecretsManagerClient();

const GLUE_TO_DB_STATUS = {
  STARTING: "running",
  RUNNING: "running",
  SUCCEEDED: "completed",
  FAILED: "failed",
  STOPPED: "failed",
  STOPPING: "running",
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

exports.handler = async () => {
  await initConnection();

  const jobName = process.env.GLUE_JOB_NAME;

  const inFlight = await sqlConnection`
    SELECT id, glue_run_id, metadata
    FROM ingestion_runs
    WHERE run_type = 'site'
      AND glue_run_id IS NOT NULL
      AND status = 'running'
  `;

  console.log(`[GlueStatusSync] Found ${inFlight.length} in-flight run(s)`);

  for (const row of inFlight) {
    try {
      const resp = await glueClient.send(new GetJobRunCommand({
        JobName: jobName,
        RunId: row.glue_run_id,
      }));

      const glueState = resp.JobRun?.JobRunState;
      const dbStatus = GLUE_TO_DB_STATUS[glueState] ?? "running";
      const isTerminal = ["completed", "failed", "stopped"].includes(dbStatus);

      await sqlConnection`
        UPDATE ingestion_runs
        SET status = ${dbStatus},
            finished_at = CASE WHEN ${isTerminal} THEN now() ELSE finished_at END
        WHERE id = ${row.id}
      `;

      console.log(`[GlueStatusSync] Run ${row.glue_run_id} → ${dbStatus}`);

      if (isTerminal) {
        const isCompleted = dbStatus === 'completed';
        const triggeredByUserId = row.metadata?.triggered_by_user_id;
        try {
          if (triggeredByUserId) {
            await writeNotification(sqlConnection, {
              userId: triggeredByUserId,
              type: isCompleted ? 'ingestion_completed' : 'ingestion_failed',
              title: isCompleted ? 'Ingestion complete' : 'Ingestion failed',
              message: isCompleted
                ? 'SharePoint ingestion finished successfully.'
                : `Ingestion ended with status "${dbStatus}".`,
              metadata: { ingestion_run_id: row.id.toString() },
            });
          } else {
            await writeNotificationToAllAdmins(sqlConnection, {
              type: isCompleted ? 'ingestion_completed' : 'ingestion_failed',
              title: isCompleted ? 'Ingestion complete' : 'Ingestion failed',
              message: isCompleted
                ? 'Scheduled SharePoint ingestion finished successfully.'
                : `Scheduled ingestion ended with status "${dbStatus}".`,
              metadata: { ingestion_run_id: row.id.toString() },
            });
          }
        } catch (notifyErr) {
          console.error(`[GlueStatusSync] Failed to write notification for run ${row.id}:`, notifyErr);
        }
      }
    } catch (e) {
      console.error(`[GlueStatusSync] Failed to sync run ${row.glue_run_id}:`, e.message);
    }
  }
};
