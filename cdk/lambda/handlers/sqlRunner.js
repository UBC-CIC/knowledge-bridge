/**
 * Manual SQL runner for DB admin/debugging.
 * Invoke directly from Lambda console — NOT attached to API Gateway.
 * Event payload: { "sql": "SELECT ..." }
 */
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const postgres = require("postgres");

const secretsManager = new SecretsManagerClient();
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
  }
};

exports.handler = async (event) => {
  const sql = event?.sql;
  if (!sql) return { error: "Missing 'sql' in event payload" };

  await initConnection();
  const result = await sqlConnection.unsafe(sql);
  return { rows: result, count: result.length };
};
