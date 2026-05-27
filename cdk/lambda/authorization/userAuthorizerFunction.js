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

  // Accept both groups — admins can use all user-facing endpoints
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
  if (!jwtVerifier) {
    await initializeVerifier();
  }

  const token = event.authorizationToken?.replace("Bearer ", "");
  if (!token) {
    console.warn("No token provided");
    throw new Error("Unauthorized");
  }

  try {
    const payload = await jwtVerifier.verify(token);

    const arnParts = event.methodArn.split("/");
    const wildcardResource = `${arnParts.slice(0, 2).join("/")}/*/*`;

    return {
      principalId: payload.sub,
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
            Resource: wildcardResource,
          },
        ],
      },
      context: {
        userId: payload.sub,
        email: payload.email,
        role: payload["cognito:groups"]?.[0] ?? "users",
      },
    };
  } catch (err) {
    console.error("Authorization error:", err.message);
    throw new Error("Unauthorized");
  }
};
