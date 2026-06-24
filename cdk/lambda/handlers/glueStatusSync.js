const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const postgres = require("postgres");

const secretsManager = new SecretsManagerClient();
const sns = new SNSClient();

const GLUE_TO_DB_STATUS = {
  SUCCEEDED: "completed",
  FAILED: "failed",
  STOPPED: "failed",
  TIMEOUT: "failed",
  ERROR: "failed",
};

let sqlConnection;

const initConnection = async () => {
  if (sqlConnection) return;
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
    const payload = {
      type: isCompleted ? "ingestion_completed" : "ingestion_failed",
      title: isCompleted ? "Ingestion complete" : "Ingestion failed",
      message: isCompleted
        ? "SharePoint ingestion finished successfully."
        : `Ingestion ended with status "${dbStatus}".`,
      metadata: { ingestion_run_id: row.id.toString() },
      ...(triggeredByUserId ? { userId: triggeredByUserId } : { broadcast: true }),
    };

    await sns.send(new PublishCommand({
      TopicArn: process.env.NOTIFICATION_TOPIC_ARN,
      Message: JSON.stringify(payload),
    }));

    console.log(`[GlueStatusSync] Published notification for run ${row.id}`);
  } catch (notifyErr) {
    console.error(`[GlueStatusSync] Failed to publish notification for run ${row.id}:`, notifyErr);
  }
};
