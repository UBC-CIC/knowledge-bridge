const { GlueClient, GetJobRunCommand } = require("@aws-sdk/client-glue");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { Client } = require("pg");

const glueClient = new GlueClient({ region: process.env.AWS_REGION });
const smClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

const GLUE_TO_DB_STATUS = {
  STARTING: "starting",
  RUNNING: "running",
  SUCCEEDED: "completed",
  FAILED: "failed",
  STOPPED: "stopped",
  STOPPING: "stopping",
  TIMEOUT: "failed",
  ERROR: "failed",
};

async function getDbClient() {
  const secret = await smClient.send(new GetSecretValueCommand({ SecretId: process.env.SM_DB_CREDENTIALS }));
  const creds = JSON.parse(secret.SecretString);
  const client = new Client({
    host: process.env.RDS_PROXY_ENDPOINT,
    port: creds.port || 5432,
    database: creds.dbname || "kba",
    user: creds.username,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

exports.handler = async () => {
  const db = await getDbClient();
  try {
    // Find all in-flight site-level runs that have a glue_run_id
    const { rows } = await db.query(`
      SELECT id, glue_run_id
      FROM ingestion_runs
      WHERE run_type = 'site'
        AND glue_run_id IS NOT NULL
        AND status NOT IN ('completed', 'failed', 'stopped')
    `);

    console.log(`[GlueStatusSync] Found ${rows.length} in-flight run(s)`);

    const jobName = process.env.GLUE_JOB_NAME;

    for (const row of rows) {
      try {
        const resp = await glueClient.send(new GetJobRunCommand({
          JobName: jobName,
          RunId: row.glue_run_id,
        }));

        const glueState = resp.JobRun?.JobRunState;
        const dbStatus = GLUE_TO_DB_STATUS[glueState] ?? "running";
        const isTerminal = ["completed", "failed", "stopped"].includes(dbStatus);

        await db.query(`
          UPDATE ingestion_runs
          SET status = $1,
              finished_at = CASE WHEN $2 THEN now() ELSE finished_at END
          WHERE id = $3
        `, [dbStatus, isTerminal, row.id]);

        console.log(`[GlueStatusSync] Run ${row.glue_run_id} → ${dbStatus}`);
      } catch (e) {
        console.error(`[GlueStatusSync] Failed to sync run ${row.glue_run_id}:`, e.message);
      }
    }
  } finally {
    await db.end();
  }
};
