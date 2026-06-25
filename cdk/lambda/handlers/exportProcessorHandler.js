const postgres = require("postgres");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { S3Client } = require("@aws-sdk/client-s3");
const { publishNotification } = require("./utils/publishNotification");
const exportRegistry = require("./exports/index");

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
        SELECT id, scope, scope_id, export_type, metadata, requested_by
        FROM export_runs
        WHERE id = ${exportRunId}
        LIMIT 1
      `;
      if (!run) throw new Error(`export_runs row not found: ${exportRunId}`);

      await sqlConnection`UPDATE export_runs SET status = 'processing' WHERE id = ${exportRunId}`;

      await exportRegistry.run(exportRunId, run, { sqlConnection, s3Client, publishNotification });

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
      try {
        const [run] = await sqlConnection`SELECT requested_by, scope FROM export_runs WHERE id = ${exportRunId} LIMIT 1`;
        if (run?.requested_by) {
          await publishNotification({
            userId: run.requested_by.toString(),
            type: 'export_failed',
            title: 'Export failed',
            message: `Your "${run.scope}" export could not be completed: ${err.message}`,
            metadata: { export_run_id: exportRunId },
          });
        }
      } catch (notifyErr) {
        console.error('Failed to publish export_failed notification:', notifyErr);
      }
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
