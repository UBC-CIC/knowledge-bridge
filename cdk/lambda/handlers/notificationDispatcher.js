const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const postgres = require("postgres");
const { writeNotification, writeNotificationToAllAdmins } = require("./utils/notificationWriter");

const secretsManager = new SecretsManagerClient();

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

  const results = await Promise.allSettled(
    event.Records.map(async (record) => {
      const { userId, type, title, message, metadata = {}, broadcast } = JSON.parse(record.Sns.Message);

      if (broadcast) {
        await writeNotificationToAllAdmins(sqlConnection, { type, title, message, metadata });
      } else {
        if (!userId) throw new Error("userId is required when broadcast is false");
        await writeNotification(sqlConnection, { userId, type, title, message, metadata });
      }
    })
  );

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[NotificationDispatcher] Record ${i} failed:`, r.reason);
    }
  });
};
