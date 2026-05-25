const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const jwt = require("jsonwebtoken");

const secretsManager = new SecretsManagerClient();
let cachedSecret;

exports.handler = async (event) => {
  const connectionId = event.requestContext?.connectionId;
  const domainName = event.requestContext?.domainName;
  const stage = event.requestContext?.stage;
  const timestamp = new Date().toISOString();

  try {
    const token = extractToken(event);

    if (!token) {
      console.warn("WebSocket connect rejected: missing token", {
        connectionId,
        domainName,
        stage,
        timestamp,
      });

      return { statusCode: 401, body: "Unauthorized" };
    }

    if (!cachedSecret) {
      const response = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
      );
      cachedSecret = JSON.parse(response.SecretString).jwtSecret;
    }

    const decoded = jwt.verify(token, cachedSecret);

    console.log("WebSocket connection authorized", {
      connectionId,
      domainName,
      stage,
      timestamp,
      claims: {
        sub: decoded?.sub,
        role: decoded?.role,
        jti: decoded?.jti,
      },
    });

    return { statusCode: 200 };
  } catch (error) {
    console.error("WebSocket connect rejected: invalid token", {
      connectionId,
      domainName,
      stage,
      timestamp,
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

  const requestBody = event.body;
  if (requestBody) {
    try {
      const parsedBody = JSON.parse(requestBody);
      if (parsedBody?.token) {
        return parsedBody.token;
      }
    } catch (err) {
      // Ignore JSON parse errors; body is optional for connect events
    }
  }

  return undefined;
}
