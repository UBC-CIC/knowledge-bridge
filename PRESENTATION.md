# Co-op Presentation: CUCCIO Knowledge Bridge Assistant

16 slides across 3 pillars: Authentication, Data Access Control, Ingestion Pipeline.

---

## Slide 1 — Title
**Title:** CUCCIO Knowledge Bridge: A Serverless RAG Chatbot on AWS
**Subtitle:** Co-op Technical Presentation — [Your Name], [Term]

---

## Slide 2 — Problem Statement
- CUCCIO staff manually review SharePoint (lists, surveys, documents) to produce summaries for CIO members
- Institutional knowledge is slow to access and at risk of being lost
- No way to query across lists — "what did universities say about X last year?" requires hours of manual review

**One-liner:** Replace manual SharePoint review with a conversational AI that answers questions over institutional data in real time.

---

## Slide 3 — System Overview
**Visual (top-to-bottom flow):**
```
Microsoft Entra ID (identity)
        ↓
   Cognito User Pool (OIDC federation)
        ↓
   API Gateway (REST + WebSocket) + WAF
        ↓                    ↓
 Lambda Functions      Text Generation Lambda
        ↓                    ↓
   RDS Postgres         pgvector similarity search
        ↑                    ↑
   AWS Glue Job ← SharePoint (Graph API)
```

- Frontend: React app on AWS Amplify
- Backend: ~8 Lambda functions, API Gateway, RDS Postgres on Graviton (ca-central-1)
- Ingestion: AWS Glue Python job → Cohere embeddings → pgvector
- Auth: Microsoft Entra ID federated through AWS Cognito

---

## Slide 4 — Auth: Identity Federation
**Title:** Authentication — Federated Identity with Entra ID + Cognito

We don't manage passwords. Entra ID is the source of truth; Cognito is the AWS-side broker.

1. User logs in → redirected to Cognito Hosted UI
2. Cognito has an OIDC Identity Provider at `https://login.microsoftonline.com/{tenantId}/v2.0`
3. Authorization Code Grant with scopes: `openid, email, profile`
4. Entra `upn` claim mapped to Cognito `custom:upn` — resolves guest accounts with `#EXT#` in UPN
5. Cognito issues a signed ID token → passed as `Bearer` header on every API call

**Key point:** Cognito credentials live in Secrets Manager, not Lambda env vars — rotatable without redeployment.

**Post-auth trigger:** `addUserOnSignUp.js` fires on `POST_AUTHENTICATION` → upserts user into RDS on first sign-in. Zero manual provisioning.

---

## Slide 5 — Auth: Dual Lambda Authorizers
**Title:** Authentication — Two Lambda Authorizers, Two Trust Levels

API Gateway has no built-in notion of admin vs user — enforced via two separate TOKEN-type Lambda authorizers.

| | `adminAuthorizerFunction.js` | `userAuthorizerFunction.js` |
|---|---|---|
| Library | `aws-jwt-verify` | `aws-jwt-verify` |
| Extra constraint | Token must have `groups: "admin"` | Any valid token |
| Returns | IAM policy + `{ userId, email, role: "admin" }` | IAM policy + `{ userId, email, role }` |
| Applied to | All `/admin/*` routes | `/user/*`, `/chat_sessions/*`, `/system_message/*` |
| TTL cache | None | 300 seconds |

**Defense-in-depth:** The admin handler itself re-checks `event.requestContext.authorizer.role !== 'admin'` and returns 403 — guards against stale cached policies.

**On failure:** Authorizers throw `"Unauthorized"` → API Gateway returns HTTP 401.

---

## Slide 6 — Auth: WebSocket Auth
**Title:** Authentication — WebSocket Streaming

Text generation is streamed over WebSocket, so standard per-request auth doesn't apply.

- At WebSocket `$connect`, `connect.js` validates the Cognito JWT via `aws-jwt-verify` (same Secrets Manager secret)
- Invalid token → connection rejected before any data flows
- This is the only auth opportunity — once connected, there's no per-message check

**Bonus:** `cognitoOriginSync` Lambda listens on EventBridge for SSM Parameter Store changes. When Amplify deploys a new URL, it auto-updates Cognito's allowed callback/logout list — no manual config after deployment.

---

## Slide 7 — Access Control: IAM Role Separation
**Title:** Data Access Control — Least-Privilege Lambda Roles

Every Lambda has only the permissions it needs. Four distinct IAM roles:

| Role | Lambda(s) | Key permissions |
|---|---|---|
| `publicRole` | userFunction, chatSession, systemMessages | RDS user secret, Cognito user management |
| `textGenRole` | textGeneration | RDS, Bedrock InvokeModel/ConverseStream, Guardrail, WebSocket |
| `adminLambdaRole` | adminFunction, glueStatusSync, sqlRunner | RDS + table-creator secret, Glue start/stop, CloudWatch, EventBridge |
| `cognitoLambdaRole` | addUserOnSignUp | RDS table-creator secret, Cognito AdminAddUserToGroup |

`textGenRole` cannot touch Glue. `adminLambdaRole` cannot invoke Bedrock inference. A compromised Lambda can only reach what its role explicitly allows.

---

## Slide 8 — Access Control: WAF
**Title:** Data Access Control — Web Application Firewall

5 rules, applied to the REST API stage (priority order):

1. **AllowIngestionLogsPolling** — whitelist `/admin/ingestion/logs` from rate limits (frontend polls every 3–5s during ingestion)
2. **AWS-AWSManagedRulesCommonRuleSet** — SQLi, XSS, malformed body. `SizeRestrictions_BODY` set to COUNT for admin batch endpoints
3. **LimitUnauthenticatedRequests** — block IPs exceeding 100 req/5min without a `Bearer` token (OPTIONS preflight excluded)
4. **LimitAuthenticatedRequests** — block IPs exceeding 2000 req/5min with a valid token
5. **LimitExpensiveEndpoints** — block IPs exceeding 1000 req/5min on `/chat_sessions` paths

WAF blocks return HTTP 429 (not 403) with a friendly message. 4XX/5XX gateway responses include CORS headers so the browser sees the error body.

---

## Slide 9 — Access Control: Document-Level Group Permissions
**Title:** Data Access Control — Row-Level Permissions via Entra Groups

Different SharePoint lists have different Entra group permissions. A user shouldn't see data from lists they can't access in SharePoint.

**How it works:**
1. During ingestion, the Glue job calls the Graph API `permissions` endpoint per list. If the list has broken inheritance, fetch list-level permissions; otherwise site-level. SharePoint site groups are recursively expanded to raw Entra GUIDs.
2. Group IDs stored in `site_source_access` table AND propagated into every `document_vectors.metadata->'group_ids'` JSON array.
3. At query time:
```sql
WHERE (v.metadata->'group_ids') ?| %s   -- PostgreSQL JSONB any-of-array operator
```
where `%s` = the user's Entra group memberships (stored in `user_memberships` at sign-in).

**Key properties:**
- Users with no matching groups get zero results — no data leakage
- When SharePoint permissions change, re-ingestion updates metadata JSON only — no re-embedding required
- Permissions enforced at the DB query level, not application logic

---

## Slide 10 — Access Control: Guardrails + DB Hardening
**Title:** Data Access Control — Guardrails & Database Hardening

**Bedrock Guardrail (input filter, applied before the LLM sees the query):**
- PII anonymization: 17 entity types — `CA_HEALTH_NUMBER`, `CA_SOCIAL_INSURANCE_NUMBER`, credit cards, addresses, etc.
- Prompt injection detection at `HIGH` strength
- Blocked input message: "Sorry, I can't help with that. I'm Knowledge Bridge..."
- Guardrail ID/version in Lambda env vars — CDK redeploy auto-rotates the version

**Database hardening:**
- RDS in a private isolated subnet — no public endpoint
- `rds.force_ssl: 1` enforces TLS for all connections
- Only `appSecurityGroup` (Lambdas) and `glueSecurityGroup` (Glue) can reach port 5432
- Three Secrets Manager secrets rotated every 30 days via hosted A/B alternating-user strategy (zero-downtime)
- All Lambdas connect via RDS Proxy — connection pooling + transparent credential refresh

---

## Slide 11 — Ingestion: Overview
**Title:** Ingestion Pipeline — Overview

**Visual (linear flow):**
```
SharePoint Lists
      ↓  Microsoft Graph API (Delta API)
AWS Glue Python Shell Job
      ↓
  Claude Haiku — narrate fields → natural language paragraph
      ↓
  Semantic chunking — 400 tokens, 1-sentence overlap
      ↓
  Cohere embed-english-v3 — 1024-dim embeddings, batch 96
      ↓
  RDS Postgres — documents + document_vectors (pgvector)
```

**Glue job config:**
- Python Shell (not Spark — low data volume, simpler ops)
- `maxCapacity: 1/16 DPU` — minimal compute, cost-efficient
- Private subnet with NAT (Graph API egress) + VPC connection to RDS Proxy
- 2-hour timeout, 1 retry, max 1 concurrent run

---

## Slide 12 — Ingestion: Incremental Sync
**Title:** Ingestion Pipeline — Incremental SharePoint Sync

We don't re-ingest everything on every run.

1. Enumerate eligible lists (skip system/hidden lists, non-`genericList` templates)
2. Resolve Entra group permissions per list (feeds into slide 9)
3. Fetch changes via Graph `/items/delta?expand=fields` using stored `cursor` (deltaLink)
   - First run or `force_full=true`: fetch all items
   - Subsequent runs: only changed/deleted items since last cursor
4. **Content hash:** SHA-256 over text + raw fields + metadata (excluding group_ids). If unchanged → skip re-embedding entirely
5. Cursor saved to `site_sources.cursor` only on success → idempotent on failure, re-run resumes from last good state

Most runs process a handful of changed items, not thousands. Keeps LLM + embedding costs near zero for routine syncs.

---

## Slide 13 — Ingestion: Narration → Chunking → Embedding
**Title:** Ingestion Pipeline — Narration → Chunking → Embedding

**Step 1 — Narration (Claude Haiku):**
- SharePoint list items are key-value field pairs — terrible input for semantic search
- Claude Haiku converts cleaned fields into a natural English paragraph optimized for retrieval
- System columns stripped first. Prompt budget: 512 tokens.

**Step 2 — Semantic Chunking:**
- Narrated text split into 400-token chunks with 1-sentence overlap
- Sliding window respects paragraph boundaries
- Each chunk → one row in `document_vectors`

**Step 3 — Embedding (Cohere via Bedrock):**
- Model: `cohere.embed-english-v3`, 1024 dimensions, ca-central-1
- Batch size: 96 per API call
- `input_type: search_document` at ingestion; `input_type: search_query` at retrieval — asymmetric embedding improves retrieval accuracy
- Old vectors deleted, new vectors bulk-inserted with `::vector` cast

---

## Slide 14 — Ingestion: pgvector Retrieval
**Title:** Ingestion Pipeline — Retrieval at Query Time

**The retrieval query:**
```sql
SELECT v.content, v.metadata, d.title, d.source_url,
       1 - (v.embedding <=> %s::vector) AS similarity
FROM document_vectors v
JOIN documents d ON d.id = v.document_id
WHERE d.status = 'ingested'
  AND (v.metadata->'group_ids') ?| %s
ORDER BY v.embedding <=> %s::vector
LIMIT %s
```
- `<=>` = pgvector cosine distance operator; `1 - distance` = similarity score
- ivfflat index with `vector_cosine_ops`, `lists=100` for approximate nearest-neighbor search

**Full RAG flow:**
1. User query → Bedrock Guardrail
2. Query embedded with Cohere (`input_type: search_query`)
3. pgvector similarity search, filtered by user's Entra groups
4. Top-k chunks + metadata → Claude (Sonnet or Haiku, cross-region inference profile, us-west-2)
5. Response streamed over WebSocket to frontend

---

## Slide 15 — Admin Controls
**Title:** Admin Interface — Ingestion Controls

| Endpoint | What it does |
|---|---|
| `POST /admin/ingestion/trigger` | Creates `ingestion_runs` row (gets UUID), calls Glue `StartJobRun` with `--INGESTION_RUN_ID` |
| `POST /admin/ingestion/stop` | Calls Glue `BatchStopJobRun`, marks run as `stopping` |
| `GET /admin/ingestion/logs?jobRunId=xxx` | Reads CloudWatch `/aws-glue/python-jobs/output` via `GetLogEvents` + `nextForwardToken` pagination |
| `PUT/GET/DELETE /admin/ingestion/schedule` | CRUD on EventBridge Scheduler (cron expression + timezone) |

**Log streaming:** Frontend polls every 3–5s. `nextForwardToken` fetches only new lines each poll. WAF rule 0 whitelists this endpoint.

**Status sync:** EventBridge watches for Glue Job State Change (SUCCEEDED, FAILED, STOPPED, TIMEOUT). `glueStatusSync.js` updates the DB row, then pushes a WebSocket notification to the admin's browser.

---

## Slide 16 — Takeaways
- **Federated identity removes password management entirely** — Entra ID + Cognito gives MFA and enterprise SSO for free
- **Group IDs in vector metadata, not a join table** — permission changes propagate in one SQL UPDATE, no re-embedding
- **Delta API + content hashing** — most ingestion runs cost near-zero because unchanged documents are skipped before any LLM or embedding call
- **Narration before embedding** — structured SharePoint fields are poor semantic search inputs; LLM narration into prose dramatically improves retrieval relevance
- **Defense-in-depth auth** — authorizer + in-handler role check + WAF + IAM role separation each independently enforce access
