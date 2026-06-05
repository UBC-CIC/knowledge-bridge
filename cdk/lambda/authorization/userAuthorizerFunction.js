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

  jwtVerifier = CognitoJwtVerifier.create({
    userPoolId: credentials.VITE_COGNITO_USER_POOL_ID,
    tokenUse: "id",
    clientId: credentials.VITE_COGNITO_USER_POOL_CLIENT_ID,
  });
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

    // Derive display email from custom:upn if no direct email claim
    const tenantUpn = payload["custom:upn"] || "";
    let email = payload.email || "";
    if (!email && tenantUpn) {
      if (tenantUpn.includes("#EXT#")) {
        const base = tenantUpn.split("#EXT#")[0];
        const lastUnderscore = base.lastIndexOf("_");
        email = lastUnderscore !== -1
          ? base.slice(0, lastUnderscore) + "@" + base.slice(lastUnderscore + 1)
          : tenantUpn;
      } else {
        email = tenantUpn;
      }
    }

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
        email,
        role: payload["cognito:groups"]?.[0] ?? "user",
      },
    };
  } catch (err) {
    console.error("Authorization error:", err.message);
    throw new Error("Unauthorized");
  }
};
