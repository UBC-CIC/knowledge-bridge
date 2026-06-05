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

/**
 * Parse a guest UPN into a human-readable email.
 * Guest UPN format: localpart_domain.com#EXT#@resourcetenant.onmicrosoft.com
 * e.g. hrishi.logani_ubc.ca#EXT#@CICPROTODEV.onmicrosoft.com → hrishi.logani@ubc.ca
 */
function parseGuestEmail(upn) {
  if (!upn || !upn.includes('#EXT#')) return upn;
  const base = upn.split('#EXT#')[0]; // e.g. hrishi.logani_ubc.ca
  const lastUnderscore = base.lastIndexOf('_');
  if (lastUnderscore === -1) return upn;
  return base.slice(0, lastUnderscore) + '@' + base.slice(lastUnderscore + 1);
}

async function getEntraGroupIds(tenantUpn, tenantId, clientId, clientSecret) {
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
      path: `/v1.0/users/${encodeURIComponent(tenantUpn)}/transitiveMemberOf/microsoft.graph.group?$select=id`,
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
    console.log("Raw event:", JSON.stringify({ userName, triggerSource: event.triggerSource, userAttributes }));

    const sub = userAttributes.sub;

    // custom:upn is mapped from Entra's upn claim — #EXT# format for guests, real UPN for natives
    const tenantUpn = userAttributes['custom:upn'];

    if (!tenantUpn) {
      throw new Error(`Login failed: no upn claim returned from identity provider for user ${userName}.`);
    }

    // Parse human-readable email from guest UPN, or use as-is for native users
    const email = parseGuestEmail(tenantUpn);

    const givenName = userAttributes.given_name || "";
    const familyName = userAttributes.family_name || "";
    const displayName = `${givenName} ${familyName}`.trim() || email;

    console.log("Upserting user:", { sub, email, tenantUpn, displayName });

    await sqlConnection`
      INSERT INTO users (id, display_name, email, tenant_upn, created_at, last_seen_at)
      VALUES (${sub}::uuid, ${displayName}, ${email}, ${tenantUpn}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE
      SET email = EXCLUDED.email,
          tenant_upn = EXCLUDED.tenant_upn,
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

    // Sync Entra group IDs using tenant_upn — best effort, never blocks login
    try {
      const spSecret = await getSharePointSecret();
      const groupIds = await getEntraGroupIds(
        tenantUpn,
        spSecret.tenant_id,
        spSecret.client_id,
        spSecret.client_secret,
      );
      console.log(`Synced ${groupIds.length} Entra groups for ${tenantUpn}`);
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
