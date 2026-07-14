const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const postgres = require("postgres");

const secretsManager = new SecretsManagerClient();
let jwtVerifier;
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

async function initializeVerifier() {
  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: process.env.SM_COGNITO_CREDENTIALS })
  );
  const credentials = JSON.parse(response.SecretString);

  jwtVerifier = CognitoJwtVerifier.create({
    userPoolId: credentials.VITE_COGNITO_USER_POOL_ID,
    tokenUse: "id",
    clientId: credentials.VITE_COGNITO_USER_POOL_CLIENT_ID,
  });
}

exports.handler = async (event) => {
  const connectionId = event.requestContext?.connectionId;
  const domainName = event.requestContext?.domainName;
  const stage = event.requestContext?.stage;
  const timestamp = new Date().toISOString();

  try {
    if (!jwtVerifier) {
      await initializeVerifier();
    }

    const token = extractToken(event);

    if (!token) {
      console.warn("WebSocket connect rejected: missing token", {
        connectionId, domainName, stage, timestamp,
      });
      return { statusCode: 401, body: "Unauthorized" };
    }

    const decoded = await jwtVerifier.verify(token);

    console.log("WebSocket connection authorized", {
      connectionId, domainName, stage, timestamp,
      claims: {
        sub: decoded?.sub,
        groups: decoded?.["cognito:groups"],
      },
    });

    await initDb();
    await sqlConnection`
      INSERT INTO ws_connections (connection_id, user_id, domain_name, stage)
      VALUES (${connectionId}, ${decoded.sub}::uuid, ${domainName}, ${stage})
      ON CONFLICT (connection_id) DO UPDATE
        SET user_id = EXCLUDED.user_id, connected_at = now()
    `;

    return { statusCode: 200 };
  } catch (error) {
    console.error("WebSocket connect rejected: invalid token", {
      connectionId, domainName, stage, timestamp,
      reason: error?.message,
    });
    return { statusCode: 401, body: "Unauthorized" };
  }
};

function extractToken(event) {
  const headers = event.headers || {};
  const authHeader = headers.Authorization || headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  const queryParams = event.queryStringParameters || {};
  if (queryParams.token) {
    return queryParams.token;
  }

  return undefined;
}
