const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const postgres = require("postgres");

const secretsManager = new SecretsManagerClient();
let sqlConnection;

const initDb = async () => {
  if (sqlConnection) return;
  const res = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: process.env.SM_DB_CREDENTIALS })
  );
  const creds = JSON.parse(res.SecretString);
  sqlConnection = postgres({
    host: process.env.RDS_PROXY_ENDPOINT,
    port: creds.port,
    username: creds.username,
    password: creds.password,
    database: creds.dbname,
    ssl: { rejectUnauthorized: true },
  });
  await sqlConnection`SELECT 1`;
};

exports.handler = async (event) => {
  const connectionId = event.requestContext?.connectionId;
  console.log("WebSocket disconnected:", {
    connectionId,
    domainName: event.requestContext?.domainName,
    stage: event.requestContext?.stage,
    timestamp: new Date().toISOString(),
  });

  try {
    await initDb();
    await sqlConnection`DELETE FROM ws_connections WHERE connection_id = ${connectionId}`;
  } catch (err) {
    // $disconnect is best-effort — APIGW does not retry it
    console.error("Failed to remove ws_connection row:", err.message);
  }

  return { statusCode: 200 };
};
