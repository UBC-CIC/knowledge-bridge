const { GlueClient, GetJobRunCommand } = require("@aws-sdk/client-glue");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const postgres = require("postgres");

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
    SELECT id, glue_run_id
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
    } catch (e) {
      console.error(`[GlueStatusSync] Failed to sync run ${row.glue_run_id}:`, e.message);
    }
  }
};
