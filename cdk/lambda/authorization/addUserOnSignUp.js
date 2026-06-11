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

// Module-level caches — persist across warm Lambda invocations
let cachedSharePointSecret = null;
let cachedToken = null;
let tokenExpiresAt = 0;

async function getSharePointSecret() {
  if (cachedSharePointSecret) return cachedSharePointSecret;
  const resp = await secretsClient.send(new GetSecretValueCommand({ SecretId: SHAREPOINT_SECRET_NAME }));
  cachedSharePointSecret = JSON.parse(resp.SecretString);
  return cachedSharePointSecret;
}

async function getGraphToken(tenantId, clientId, clientSecret) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const https = require("https");
  const tokenBody = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  }).toString();

  const { access_token, expires_in } = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "login.microsoftonline.com",
      path: `/${tenantId}/oauth2/v2.0/token`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(tokenBody);
    req.end();
  });

  cachedToken = access_token;
  tokenExpiresAt = Date.now() + (expires_in * 1000);
  return cachedToken;
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

async function getEntraGroups(tenantUpn, tenantId, clientId, clientSecret) {
  const https = require("https");
  const accessToken = await getGraphToken(tenantId, clientId, clientSecret);

  const groups = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "graph.microsoft.com",
      path: `/v1.0/users/${encodeURIComponent(tenantUpn)}/transitiveMemberOf/microsoft.graph.group?$select=id,displayName`,
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => { try { resolve(JSON.parse(data).value || []); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });

  // Deduplicate by id (lowercased)
  const seen = new Set();
  return groups
    .filter((g) => { const k = g.id.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((g) => ({ id: g.id.toLowerCase(), displayName: g.displayName || g.id }));
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

    // Sync Entra groups using tenant_upn — best effort, never blocks login
    try {
      const spSecret = await getSharePointSecret();
      const groups = await getEntraGroups(
        tenantUpn,
        spSecret.tenant_id,
        spSecret.client_id,
        spSecret.client_secret,
      );
      console.log(`Synced ${groups.length} Entra groups for ${tenantUpn}`);

      if (groups.length > 0) {
        // Upsert group reference rows (id + display_name)
        await sqlConnection`
          INSERT INTO entra_groups ${sqlConnection(groups.map((g) => ({ id: g.id, display_name: g.displayName })))}
          ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
        `;
      }

      // Replace this user's memberships atomically
      await sqlConnection.begin(async (tx) => {
        await tx`DELETE FROM user_entra_groups WHERE user_id = ${sub}::uuid`;
        if (groups.length > 0) {
          await tx`
            INSERT INTO user_entra_groups ${tx(groups.map((g) => ({ user_id: sub, group_id: g.id })))}
          `;
        }
        await tx`
          UPDATE users SET entra_groups_refreshed_at = CURRENT_TIMESTAMP WHERE id = ${sub}::uuid
        `;
      });
    } catch (entraErr) {
      console.error("Entra group sync failed (non-fatal):", entraErr.message);
    }

  } catch (err) {
    console.error("Error in post-authentication trigger:", err);
  }

  return event;
};
