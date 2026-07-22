# CUCCIO Knowledge Base Assistant - Project Modification Guide

This guide covers practical modifications developers commonly need to make: styling, authentication, API extensions, frontend components, LLM configuration, database migrations, and deployment. For guardrail configuration, see `Docs/BEDROCK_GUARDRAILS.md`.

---

## Table of Contents

- [Modifying Colors and Styles](#modifying-colors-and-styles)
- [Admin & Public Token](#admin--public-token)
- [Using External Identity Providers (Enterprise SSO)](#using-external-identity-providers-enterprise-sso)
- [Extending the API](#extending-the-api)
- [Modifying Frontend Components](#modifying-frontend-components)
- [Changing Website License (Footer)](#changing-website-license-footer)
- [Configuring LLM Models](#configuring-llm-models)
- [Database Schema Changes (Migrations)](#database-schema-changes-migrations)
- [Message/Token Limit Management](#messagetoken-limit-management)
- [Data Ingestion Modifications](#data-ingestion-modifications)
- [Adding Re-Ranking to Retrieval](#adding-re-ranking-to-retrieval)
- [Deployment & Testing](#deployment--testing)
- [Encryption & KMS Keys](#encryption--kms-keys)
- [Troubleshooting & Best Practices](#troubleshooting--best-practices)

---

## Modifying Colors and Styles

The frontend uses Tailwind and CSS variables for theme colors. Primary variables are defined in `frontend/src/index.css`.

**Example** (change the primary brand color and sidebar background):

```css
/* frontend/src/index.css */
:root {
  --primary: rgb(23, 68, 103);
  --sidebar: rgb(23, 68, 103);
}

.dark {
  --primary: rgb(23, 68, 103);
  --sidebar: rgb(23, 68, 103);
}
```

For component-specific overrides, search for hex codes or Tailwind classes directly in `frontend/src/components/`.

---

## Authentication & Authorization

All users — both regular users and admins — authenticate via **Microsoft Entra ID** federated through AWS Cognito. There is no anonymous or public access.

- **Regular users**: Sign in with Microsoft via the landing page (`frontend/src/pages/LandingPage.tsx`). Cognito issues a JWT which the frontend stores and passes on all API calls.
- **Admin users**: Same Entra ID sign-in flow, but must be a member of the `admin` Cognito group. Admin-only APIs are restricted by the admin authorizer in `OpenAPI_Swagger_Definition.yaml` and `cdk/lib/api-stack.ts`. Once signed in, admins see a Mode switcher in the header to toggle between user and admin views.

Key files:
- `cdk/lib/api-stack.ts` — Cognito UserPool, Entra ID OIDC identity provider, and API authorizer setup
- `frontend/src/functions/authService.js` — `signInWithRedirect` and session management
- `frontend/src/components/ProtectedRoute.tsx` — route-level auth and admin group check

---

## Customizing the Identity Provider

The application is pre-configured with Microsoft Entra ID as the sole identity provider. To swap it for a different OIDC/SAML provider (e.g., Okta, Google Workspace):

1. In `cdk/lib/api-stack.ts`, find the `CfnUserPoolIdentityProvider` block for `EntraID` and update the `providerDetails` (issuer URL, client ID/secret) and `attributeMapping`.
2. Update `frontend/src/functions/authService.js` — change the `custom` provider name passed to `signInWithRedirect` to match the new provider's name.
3. Update redirect/callback URIs in the identity provider's app registration to include your Amplify URL.
4. Redeploy: `cdk deploy`.

AWS docs:
- OIDC: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html
- SAML: https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html

---

## Extending the API

1. Add the Lambda handler in `cdk/lambda/handlers/<your-handler>.js` (Node) or a new Python module.
2. Define a new `lambda.Function` in `cdk/lib/api-stack.ts`.
3. Wire up the API Gateway route and authorizer in `api-stack.ts`.
4. Update `OpenAPI_Swagger_Definition.yaml` to reflect the new endpoint.
5. Run `cdk deploy`.

Example (Node.js):

```typescript
const myHandler = new lambda.Function(this, `${id}-MyHandler`, {
  runtime: lambda.Runtime.NODEJS_22_X,
  code: lambda.Code.fromAsset("lambda"),
  handler: "handlers/myHandler.handler",
  environment: {
    SM_DB_CREDENTIALS: db.secretPathUser.secretName,
    RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
  },
});

const myResource = this.api.root.addResource("my-feature");
myResource.addMethod("POST", new apigw.LambdaIntegration(myHandler), {
  authorizer: this.adminAuthorizer,
});
```

Existing handlers in `cdk/lambda/handlers/` (e.g., `adminHandler.js`, `chatSessionHandler.js`) are good patterns to follow.

---

## Modifying Frontend Components

Frontend code is in `frontend/src/`:
- `pages/` — route-level pages
- `components/` — reusable UI blocks
- `providers/` — React context (e.g., `UserSessionContext`, `ModeContext`)

### Adding a new page

```tsx
// frontend/src/pages/NewFeature/NewFeature.tsx
export default function NewFeature() {
  return <div>New Feature page</div>;
}

// frontend/src/App.tsx
import NewFeature from "./pages/NewFeature/NewFeature";
<Route path="/new-feature" element={<NewFeature />} />
```

Wrap with `<ProtectedRoute>` if admin-only.

---

## Changing Website License (Footer)

Edit `frontend/src/components/Footer.tsx`:

```tsx
<div className="text-sm text-muted-foreground">
  © {new Date().getFullYear()} Your Organization Name.
</div>
```

Or use a Vite env variable to avoid rebuilding for content changes:

```tsx
© {new Date().getFullYear()} {import.meta.env.VITE_WEBSITE_NAME || 'CUCCIO Knowledge Base Assistant'}.
```

---

## Configuring LLM Models

The text generation Lambda uses two models: **Haiku** (fast, used for query rewriting) and **Sonnet** (main chat model). Their ARNs are stored as SSM parameters:

- `/KBA/LLM/HaikuArn`
- `/KBA/LLM/SonnetArn`

To update a model, change the SSM parameter value via the AWS Console or CLI:

```bash
aws ssm put-parameter \
  --name "/KBA/LLM/HaikuArn" \
  --value "us.anthropic.claude-haiku-4-5-20251001-v1:0" \
  --type String \
  --overwrite
```

**Rules when updating:**
- All ARNs must use the `us.` cross-region inference prefix (e.g., `us.anthropic.claude-...`).
- Only update `SonnetArn` with a Sonnet-family model — it's used for the main chat flow and has specific prompt/output handling tied to it.
- `HaikuArn` can be any fast, low-cost model suitable for query rewriting.

> **Note:** If you switch to a different model family, you'll also need to update the IAM policy on the `lambdaTextGen` role to allow `bedrock:InvokeModel` for the new model ARN. This is configured in `cdk/lib/api-stack.ts` under `textGenBedrockPolicyStatement`.

For guardrail configuration, see `Docs/BEDROCK_GUARDRAILS.md`.

---

## Database Schema Changes (Migrations)

Migrations live in `cdk/lambda/db_setup/migrations/` and follow a numbered naming convention.

```javascript
// cdk/lambda/db_setup/migrations/015_add_new_feature_table.js
exports.up = async function (knex) {
  return knex.schema.createTable('new_feature', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.text('description');
    table.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  return knex.schema.dropTable('new_feature');
};
```

---

## Message/Token Limit Management

Token and message limits (daily token limit, max characters per message, min exchanges before suggestion, etc.) are admin-configurable at runtime — they're stored in the database and loaded by the Lambda on startup. No redeployment is needed to change them.

For details on how to configure these via the admin dashboard, see the User Guide.

---

## Data Ingestion Modifications

The ingestion pipeline is an AWS Glue Python Shell job at `cdk/glue/sharepoint_ingestion.py`. Key areas to modify:

- **SharePoint content source**: The job uses the Microsoft Graph API (via `msgraph-sdk`) to fetch list items. To change which SharePoint sites or lists are ingested, update the site/list IDs in the job or in the `sites` / `site_sources` database tables.
- **Chunking logic**: Text splitting happens inside the job before embedding. Adjust chunk size and overlap directly in the script.
- **Embedding**: Chunks are embedded by calling Amazon Bedrock (Cohere Embed English v3). To swap embedding models, update the model ID in the script and ensure the Glue IAM role has `bedrock:InvokeModel` permission for the new model ARN.
- **Schema changes**: If new metadata columns are needed, add a migration in `cdk/lambda/db_setup/migrations/` and redeploy `DBFlowStack` before the next ingestion run.

To trigger a run manually, use the **Run Ingestion** button in the admin dashboard or call `POST /admin/ingestion/trigger`.

---

## Adding Re-Ranking to Retrieval

The current retrieval pipeline embeds the user query, runs a cosine similarity search against `document_vectors`, and passes the top-N chunks directly to the LLM. As the knowledge base grows to cover many topic areas, chunks that are semantically similar to the query but not actually relevant to the specific question can start slipping into that top-N. Adding a re-ranking step between retrieval and generation filters those out and can significantly improve answer quality.

**When to consider this:** When the number of ingested documents grows large enough that retrieval precision drops noticeably — i.e. the LLM is receiving off-topic chunks and hedging or hallucinating more often.

**The only file that needs to change is `cdk/lambda/textGeneration/helpers/bedrock.py`**, specifically the `retrieve_documents` function. No other files need modification — `chat.py` calls `retrieve_documents()` and receives the same return shape regardless.

The change is two steps:

1. **Fetch a larger candidate set from pgvector** — increase the SQL `LIMIT` to e.g. 3× your `max_context_chunks` so the re-ranker has candidates to work with:

```python
# Before
ORDER BY v.embedding <=> %s::vector
LIMIT %s
# ...
_vector_literal(embedding),
max_context_chunks,

# After — fetch a wider candidate pool
CANDIDATE_MULTIPLIER = 3
ORDER BY v.embedding <=> %s::vector
LIMIT %s
# ...
_vector_literal(embedding),
max_context_chunks * CANDIDATE_MULTIPLIER,
```

2. **Call Bedrock Rerank and slice the top-N** — add this after the pgvector query returns `results`:

```python
if results:
    rerank_response = bedrock_client.rerank(
        rerankingConfiguration={
            "type": "BEDROCK_RERANKING_MODEL",
            "bedrockRerankingConfiguration": {
                "modelConfiguration": {
                    "modelArn": f"arn:aws:bedrock:{os.environ['AWS_REGION']}::foundation-model/amazon.rerank-v1:0"
                },
                "numberOfResults": max_context_chunks,
            },
        },
        sources=[
            {"type": "INLINE", "inlineDocumentSource": {"type": "TEXT", "textDocument": {"text": r["content"]}}}
            for r in results
        ],
        textSources=[{"type": "QUERY", "textQuery": {"text": query}}],
    )
    reranked_indices = [item["index"] for item in rerank_response["rerankingResults"]]
    results = [results[i] for i in reranked_indices]
```

**IAM**: The Lambda execution role needs `bedrock:Rerank` added to its Bedrock policy in `cdk/lib/api-stack.ts`.

**Cost**: Bedrock Rerank (`amazon.rerank-v1:0`) charges per 1,000 tokens reranked — small relative to the generation call, and available in `ca-central-1`.

---

## Deployment & Testing

**CDK / Backend:**
```bash
cd cdk
npm install
npm run build
cdk deploy
```

**Python Lambda dependencies:**
The `textGeneration` Lambda does not auto-install `requirements.txt` at deploy time — dependencies come from Lambda layers (`psycopg2`, etc.). If you add a new Python dependency, you'll need to either add a layer or set up a bundling step in CDK.

**Glue job dependencies:**
Edit `cdk/glue/requirements.txt` and redeploy the `GlueStack`. The CDK stack uploads the file to S3 and passes it to the Glue job as `--additional-python-modules`. See `Docs/DEPENDENCY_MANAGEMENT.MD` for details.

**Frontend:**
```bash
cd frontend
npm install
npm run build   # production build
```

Run the dev server manually with `npm run dev` (Vite).

**CI/CD:** See `Docs/DEPLOYMENT_GUIDE.md` for pipeline specifics.

---

## Encryption & KMS Keys

By default, all encrypted resources in this project (RDS, S3, Secrets Manager) use AWS managed keys. No configuration is required to use them, but they offer limited control over key rotation, auditing, and cross-account access.

If your organization requires customer-managed KMS keys (CMKs), see [`Docs/AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md) for a full list of affected resources and the exact CDK property changes needed in each stack.

---

## Troubleshooting & Best Practices

- **Lambda Timeout**: Increase `timeout` in the CDK function definition.
- **Memory/Latency**: Increase `memorySize`; check VPC and RDS proxy config.
- **Database**: Verify `SM_DB_CREDENTIALS` in Secrets Manager and RDS proxy endpoint.
- **Cognito**: Check user pool and client IDs in `frontend/.env`.
- **Guardrails**: See `Docs/BEDROCK_GUARDRAILS.md` for topic policies, allow rules, and testing.
- **Logging**: CloudWatch logs are the primary debugging source for all Lambdas.
