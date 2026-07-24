const postgres = require("postgres");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const secretsManager = new SecretsManagerClient();
let sqlConnection;

const initConnection = async () => {
  if (!sqlConnection) {
    try {
      const res = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: process.env.SM_DB_CREDENTIALS })
      );
      const credentials = JSON.parse(res.SecretString);

      sqlConnection = postgres({
        host: process.env.RDS_PROXY_ENDPOINT,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        database: credentials.dbname,
        ssl: { rejectUnauthorized: true },
      });

      await sqlConnection`SELECT 1`;
      console.log("Database connection initialized successfully");
    } catch (error) {
      console.error("Error initializing database connection:", error.message);
      throw error;
    }
  }
};

const getSqlConnection = () => sqlConnection;

module.exports = { initConnection, getSqlConnection };
