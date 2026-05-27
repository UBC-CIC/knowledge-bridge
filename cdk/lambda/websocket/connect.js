const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { CognitoJwtVerifier } = require("aws-jwt-verify");

const secretsManager = new SecretsManagerClient();
let jwtVerifier;

async function initializeVerifier() {
  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: process.env.SM_COGNITO_CREDENTIALS })
  );
  const credentials = JSON.parse(response.SecretString);

  jwtVerifier = CognitoJwtVerifier.create([
    {
      userPoolId: credentials.VITE_COGNITO_USER_POOL_ID,
      tokenUse: "id",
      clientId: credentials.VITE_COGNITO_USER_POOL_CLIENT_ID,
      groups: "users",
    },
    {
      userPoolId: credentials.VITE_COGNITO_USER_POOL_ID,
      tokenUse: "id",
      clientId: credentials.VITE_COGNITO_USER_POOL_CLIENT_ID,
      groups: "admin",
    },
  ]);
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
