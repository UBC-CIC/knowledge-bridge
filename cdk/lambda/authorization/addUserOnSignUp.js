const { initializeConnection } = require("./initializeConnection.js");
const {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT, SHAREPOINT_SECRET_NAME } = process.env;
let sqlConnection = global.sqlConnection;
const cognitoClient = new CognitoIdentityProviderClient();
const secretsClient = new SecretsManagerClient();

async function getSharePointSecret() {
  const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: SHAREPOINT_SECRET_NAME }));
  return JSON.parse(resp.SecretString);
}

async function getEntraGroupIds(email, tenantId, clientId, clientSecret) {
  const https = require("https");

  const tokenBody = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  }).toString();

  const accessToken = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "login.microsoftonline.com",
      path: `/${tenantId}/oauth2/v2.0/token`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data).access_token); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(tokenBody);
    req.end();
  });

  const groups = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "graph.microsoft.com",
      path: `/v1.0/users/${encodeURIComponent(email)}/transitiveMemberOf/microsoft.graph.group?$select=id`,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data).value || []); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });

  return [...new Set(groups.map((g) => g.id.toLowerCase()))];
}

exports.handler = async (event) => {
  console.log("Post-authentication trigger:", {
    userName: event.userName,
    userPoolId: event.userPoolId,
    triggerSource: event.triggerSource,
  });

  if (!sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnection = global.sqlConnection;
  }

  const { userName, userPoolId, request } = event;

  try {
    const userAttributes = request.userAttributes;
    const sub = userAttributes.sub;
    const email = userAttributes.email;
    const givenName = userAttributes.given_name || "";
    const familyName = userAttributes.family_name || "";
    const displayName = `${givenName} ${familyName}`.trim() || email;

    console.log("Upserting user:", { sub, email, displayName });

    await sqlConnection`
      INSERT INTO users (id, display_name, email, created_at, last_seen_at)
      VALUES (${sub}::uuid, ${displayName}, ${email}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          last_seen_at = CURRENT_TIMESTAMP
    `;

    // Auto-assign to 'users' group (admins are added manually)
    try {
      await cognitoClient.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: userName,
        GroupName: "users",
      }));
    } catch (groupErr) {
      console.warn("Could not add user to group (may already be a member):", groupErr.message);
    }

    // Sync Entra group IDs — best effort, never blocks login
    try {
      const spSecret = await getSharePointSecret();
      const groupIds = await getEntraGroupIds(
        email,
        spSecret.tenant_id,
        spSecret.client_id,
        spSecret.client_secret,
      );
      console.log(`Synced ${groupIds.length} Entra groups for ${email}`);
      await sqlConnection`
        UPDATE users
        SET entra_group_ids = ${groupIds},
            entra_groups_refreshed_at = CURRENT_TIMESTAMP
        WHERE id = ${sub}::uuid
      `;
    } catch (entraErr) {
      console.error("Entra group sync failed (non-fatal):", entraErr.message);
    }

  } catch (err) {
    console.error("Error in post-authentication trigger:", err);
  }

  return event;
};
