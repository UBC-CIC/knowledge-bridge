# Microsoft Entra ID + Amazon Cognito OIDC Federation Setup

> **This document is superseded by [`ENTRA_SETUP.md`](./ENTRA_SETUP.md).** The new guide is accurate against the current CDK code and includes screenshot placeholders. Use that document instead.
>
> Known discrepancies in this file (do not use):
> - Attribute mapping shows `email: cognito.ProviderAttribute.other("upn")` — the code actually maps `upn → custom:upn`
> - Secrets delivery shows `-c entraClientId=...` context flags — the code reads from Secrets Manager directly; no context flags are needed

---

---

## Overview

When a user clicks "Sign in with Microsoft", here's what happens end to end:

1. Frontend calls Amplify `signInWithRedirect` → user is sent to the Cognito hosted UI
2. Cognito redirects the user to Microsoft's login page
3. User signs in with their org Microsoft account
4. Microsoft sends an OIDC token back to Cognito
5. Cognito creates/finds the user in the user pool and issues its own JWT tokens
6. A Lambda trigger fires, creates the user in RDS, and syncs their Entra group memberships
7. User lands back in the app, authenticated

---

## Part 1 — Azure Portal Setup

### 1.1 Find the Right App Registration

You need an existing **App Registration** in Entra ID that already has Graph API access (used by the Glue ingestion job). Do not create a new one — reuse the same app so the permissions are consolidated.

**How to find it:**
1. Go to **AWS Secrets Manager → KBA-SharePoint-Credentials** → retrieve the secret
2. Note the `client_id` value
3. Go to **Azure Portal → Microsoft Entra ID → App Registrations**
4. Search for the app whose **Application (client) ID** matches that `client_id`

> **App Registrations vs Enterprise Applications:** Every App Registration has a corresponding Enterprise Application with the same name. App Registration is where you configure credentials and permissions. Enterprise Application is where you manage user assignments and SSO. They are two views of the same thing.

### 1.2 Find Your Tenant ID

Your **Tenant ID** is the same for every app in your organization.

Go to **Azure Portal → Microsoft Entra ID → Overview** — it's listed as **Tenant ID** on that page.

### 1.3 Add Required API Permissions

Your app needs these **Application permissions** (not Delegated) on Microsoft Graph so the Lambda can look up any user's group memberships server-side without a signed-in user context:

| Permission | Type | Purpose |
|---|---|---|
| `User.Read` | Delegated | Already exists — for user sign-in |
| `User.Read.All` | **Application** | Look up any user by email |
| `GroupMember.Read.All` | **Application** | Get a user's transitive group memberships |

**How to add them:**
1. App Registration → **API Permissions** → **Add a permission**
2. Select **Microsoft Graph** → **Application permissions**
3. Search for and add `User.Read.All` and `GroupMember.Read.All`
4. Click **Grant admin consent for [your org]** — this is critical, without it the permissions are listed but not active
5. Both rows should show a green checkmark saying "Granted for [your org]"

> **Why Application permissions?** The Lambda runs server-side with no signed-in user. It uses the app's own credentials (client ID + secret) to get a token, then calls Graph on behalf of the application itself. This requires Application permissions, not Delegated ones. Delegated permissions only work when there's a signed-in user context.

### 1.4 Add the Cognito Redirect URI

Cognito needs to receive the OIDC token from Microsoft after the user logs in. You must register Cognito's callback URL as an allowed redirect on the app registration.

1. App Registration → **Authentication**
2. Under **Web** platform (add it if it doesn't exist — click **Add a platform → Web**)
3. Add redirect URI: `https://cic-kba.auth.ca-central-1.amazoncognito.com/oauth2/idpresponse`
4. Under **Implicit grant and hybrid flows**, check **ID tokens**
5. Save

> **Why Web platform and not SPA?** The redirect goes to Cognito's server-side endpoint, not directly to the browser. Cognito then handles the token exchange and redirects to your frontend. So it's a server-side (Web) callback, not a browser-side (SPA) one.

### 1.5 Verify the UPN Claim Is in the Token

The Lambda trigger identifies users by their **UPN (User Principal Name)** — their `username@domain.com` work account address. This is used both to create the user row in RDS and to look them up in the Graph API for group membership sync.

Entra ID includes `upn` in ID tokens by default for most org tenants, but you should verify it is present.

**How to check:**
1. App Registration → **Token configuration**
2. Look for an optional claim entry for `upn` under **ID token**
3. If it's not listed there, it's still included by default — Entra always emits `upn` in the ID token for organizational accounts

**What NOT to do:**
- Do not try to add `oid` (Object ID) as an optional claim — Entra blocks this for this claim type
- Do not try to add `email` as the primary identifier — the `mail` property is null for many org accounts
- Do not rely on `name` as an optional claim — it can also be blocked depending on tenant policy

**How the Lambda uses it:**

The CDK maps the Entra `upn` claim to the Cognito `email` attribute:
```typescript
attributeMapping: {
  email: cognito.ProviderAttribute.other("upn"),
  givenName: cognito.ProviderAttribute.other("given_name"),
  familyName: cognito.ProviderAttribute.other("family_name"),
}
```

So inside the Lambda trigger, `userAttributes.email` is actually the UPN. The fallback `userAttributes.upn` covers cases where the mapping hasn't propagated yet. Either way the Lambda gets the right value.

---

## Part 2 — AWS CDK Deployment

### 2.1 What the CDK Does

The CDK wires up three things:

1. **Cognito Hosted UI domain** (`cic-kba`) — required for OIDC federation. This gives Cognito a URL to receive the Microsoft callback.
2. **OIDC Identity Provider** — tells Cognito to trust tokens from Entra ID and how to map Entra claims (email, name) to Cognito user attributes.
3. **Updated App Client** — enables OAuth authorization code flow with the correct scopes and callback URLs.

### 2.2 Secrets — Why They're Passed as Context Flags

The OIDC provider in Cognito needs `clientId`, `clientSecret`, and `tenantId` baked into the CloudFormation template at **synth time** (when CDK generates the template). This happens before any Lambda runs, so you can't read Secrets Manager during synth.

These values come from **Secrets Manager → KBA-SharePoint-Credentials** (`client_id`, `client_secret`, `tenant_id`). They're passed as `-c` flags at deploy time so they never touch the codebase:

```bash
cdk deploy --all \
  --context StackPrefix=KBA \
  --context environment=dev \
  --context version=1.0.0 \
  --context githubRepo=knowledge-base-assistant \
  --context entraClientId=YOUR_CLIENT_ID \
  --context entraClientSecret=YOUR_CLIENT_SECRET \
  --context entraTenantId=YOUR_TENANT_ID \
  --profile kba-dev --require-approval never
```

> **Security note:** Never put these values in `cdk.json` or commit them to git. Always pass them as `-c` flags. If you accidentally expose the client secret, rotate it immediately in Azure Portal → App Registration → Certificates & secrets.

### 2.3 Hardcoded Amplify URL

There is a known limitation: the Amplify app URL is hardcoded in two places in the CDK:

- `cdk/lib/api-stack.ts` — used as the Cognito OAuth callback/logout URL
- `cdk/lib/amplify-stack.ts` — used as the `VITE_APP_URL` frontend env var

**Why it's hardcoded:** `ApiStack` deploys before `AmplifyStack`, so the Amplify URL isn't known at `ApiStack` synth time. The Amplify `appId` also can't be referenced inside its own constructor. Both files have `// TODO` comments marking this.

**If you redeploy to a new AWS account** with a different Amplify app, you'll need to update both hardcoded values with the new app's URL before deploying.

Both are marked with `// TODO: fix cyclic dependency` in the code.

---

## Part 3 — How the Lambda Trigger Works

### 3.1 What Fires When

Cognito has two relevant triggers for authentication:

| Trigger | When it fires |
|---|---|
| **Post Confirmation** | First ever sign-in for a federated (Microsoft) user |
| **Post Authentication** | Every subsequent sign-in |

Both triggers point to the same Lambda (`KBA-addMemberOnSignUp`) so it runs on every login regardless of whether it's the first or a repeat login.

> **Why two triggers?** For native Cognito (email/password) users, Post Confirmation fires after email verification. For federated (Microsoft) users, Cognito fires Post Confirmation on the very first login instead of Post Authentication. Without both triggers, group sync would be skipped on a user's very first login.

### 3.2 What the Lambda Does

On every login it:

1. Upserts the user row in RDS (`users` table) with their `sub`, `email`, and `display_name`
2. Adds them to the Cognito `users` group (admins are added manually)
3. Reads `KBA-SharePoint-Credentials` from Secrets Manager to get `tenant_id`, `client_id`, `client_secret`
4. Gets an app-level Graph token via client credentials flow
5. Calls `GET /v1.0/users/{email}/transitiveMemberOf/microsoft.graph.group` to get all Entra groups the user belongs to
6. Writes the group IDs (deduplicated, lowercased) to `users.entra_group_ids` and `users.entra_groups_refreshed_at`

Steps 3–6 are wrapped in try/catch — if the Graph call fails for any reason, the login still succeeds. The user just won't have group data until the next login.

### 3.3 Why Group Sync Matters

The vector search in text generation filters chunks by `metadata->'group_ids'` using a PostgreSQL `?|` array overlap check:

```sql
AND (v.metadata->'group_ids') ?| ARRAY['group-id-1', 'group-id-2']
```

A user only sees content from SharePoint lists that their Entra groups have explicit access to. SharePoint admin access does not bypass this — only actual Entra group membership counts.

---

## Part 4 — Verifying It Works

After deploying, verify the full flow:

**1. Check the user was created in RDS:**
```sql
SELECT id, email, entra_group_ids, entra_groups_refreshed_at
FROM users
WHERE email = 'your-email@domain.com';
```

`entra_group_ids` should be a non-empty array and `entra_groups_refreshed_at` should have a recent timestamp.

**2. Check group IDs match what's on your chunks:**
```sql
SELECT DISTINCT jsonb_array_elements_text(metadata->'group_ids') AS group_id
FROM document_vectors;
```

Cross-reference with your user's `entra_group_ids`. If there's no overlap, the user won't get any results from text generation — they need to be a member of an Entra group that has SharePoint list access.

**3. Check CloudWatch logs if something goes wrong:**

Log group: `/aws/lambda/KBA-addMemberOnSignUp`

Common errors:

| Error | Cause | Fix |
|---|---|---|
| `403 Forbidden` on Graph call | `User.Read.All` or `GroupMember.Read.All` not admin-consented | Go to App Registration → API Permissions → Grant admin consent |
| `403 Authorization_RequestDenied` | Permissions added but admin consent not clicked | Same as above — the green checkmark must appear |
| `entra_group_ids column does not exist` | Migration `005` hasn't run yet | Redeploy DBFlowStack |
| No logs at all on first login | Post Confirmation trigger not wired up | CDK now wires both triggers — redeploy ApiStack |
| `entra_group_ids` is empty array `{}` | Lambda used wrong identifier for Graph call (not UPN) | Verify `userAttributes.email` in logs contains the actual UPN, not undefined |
| User row has `email: null` or insert fails | Entra token has no `email` or `upn` claim | Check CDK attribute mapping — `upn` must be mapped to `email` |
| Group sync works but user still sees no results | User is not a member of the Entra groups that have SharePoint list access | Check SharePoint list permissions → the list must be shared with an Entra security group, and the user must be a member of that group |
