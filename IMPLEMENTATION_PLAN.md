# Implementation Plan: Replace Bedrock KB with pgvector + SharePoint Glue Pipeline

## Overview
Replacing KnowledgeBaseStack + CICDStack with pgvector on RDS Postgres, an AWS Glue SharePoint ingestion job, two new admin Lambda endpoints, and updated text generation retrieval. Frontend gets an ingestion control panel.

---

## Step 1 — Schema Migration
**File to create:** `cdk/lambda/db_setup/migrations/001_pgvector_sharepoint.js`

- Enable `pgvector` and `uuid-ossp` extensions
- Create `sites`, `site_sources`, `documents`, `document_vectors` tables per CLAUDE.md DDL
- Create new `ingestion_runs` table with expanded schema (site_id, source_id, run_type, triggered_by, status, started_at, finished_at, document counts, error_message, metadata)
- Add all indexes including `ivfflat` on `document_vectors.embedding` with `vector_cosine_ops`

- Rename existing `ingestion_runs` (old pipeline) to `ingestion_runs_legacy`, then create new `ingestion_runs` with expanded schema

---

## Step 2 — Strip CDK
**Files:** `cdk/bin/cdk.ts`, `cdk/lib/api-stack.ts`
**Files to delete:** `cdk/lib/knowledge-base-stack.ts`, `cdk/lib/cicd-stack.ts`
**Directories to delete:** `cdk/lambda/knowledgeBase/`, `cdk/lambda/vectorIndexManagerSigV4/`, `cdk/lambda/ecrImageWaiter/`, `cdk/lambda/knowledgeBaseProvisioner/`

- Remove `KnowledgeBaseStack` and `CICDStack` from `cdk/bin/cdk.ts`: imports, instantiations, `.addDependency()` calls, stack tags
- Remove from `ApiGatewayStack`: `knowledgeBaseBucket` prop, `knowledgeBaseSecret` prop, `lambdaKnowledgeBase` Lambda, scheduler infrastructure, ECR repo wiring, all `ecrRepositories` references

---

## Step 3 — GlueStack
**Files to create:** `cdk/lib/glue-stack.ts`, `cdk/glue/sharepoint_ingestion.py`

- New `GlueStack` with a Glue Python Shell job running in the same VPC as RDS
- IAM role with: Secrets Manager read (SharePoint creds), Bedrock `InvokeModel` (Titan Embed), CloudWatch Logs write, VPC/RDS access
- SharePoint secret in Secrets Manager: tenant ID, client ID, client secret
- Glue job script (`sharepoint_ingestion.py`): Graph API → fetch pages/documents → chunk text → embed via `amazon.titan-embed-text-v2:0` (1024 dims) → upsert into `document_vectors` via psycopg2
- Wire `GlueStack` into `cdk/bin/cdk.ts`

---

## Step 4 — New Admin Lambda Endpoints
**Files:** `cdk/lambda/handlers/adminHandler.js`, `cdk/OpenAPI_Swagger_Definition.yaml`, `cdk/lib/api-stack.ts`

- `POST /admin/ingestion/trigger` — calls `glue.startJobRun()`, returns `{ jobRunId }`
- `GET /admin/ingestion/logs?jobRunId=xxx&nextToken=yyy` — calls CloudWatch `GetLogEvents` on the Glue job log group, returns log lines + `nextForwardToken`
- Add both routes to OpenAPI YAML with admin Cognito authorizer
- Grant the admin Lambda IAM role: `glue:StartJobRun`, `logs:GetLogEvents`, `logs:DescribeLogStreams`

---

## Step 5 — Text Generation Swap
**Files:** `cdk/lambda/textGeneration/helpers/bedrock.py`, `cdk/lib/api-stack.ts`

- Replace `bedrock-agent-runtime.retrieve()` with direct psycopg2 query
- Embed user query via Titan (`amazon.titan-embed-text-v2:0`)
- Cosine similarity search: `SELECT content, metadata FROM document_vectors ORDER BY embedding <=> %s LIMIT 5`
- Connect via `RDS_PROXY_ENDPOINT` env var (same pattern as other Lambdas)
- In `api-stack.ts`: remove `KNOWLEDGE_BASE_ID` env var from textGeneration Lambda, add `RDS_PROXY_ENDPOINT` and `DB_SECRET_ARN`

---

## Step 6 — Frontend
**Files:** relevant admin components under `frontend/src/`

- New **Ingestion** tab in admin panel
- "Trigger Ingestion" button → calls `POST /admin/ingestion/trigger`
- Real-time log window: polls `GET /admin/ingestion/logs?jobRunId=xxx` every 3-5 seconds, appends lines, stops on terminal status (SUCCEEDED / FAILED / STOPPED)
- Display current job status prominently

---

## Status

| Step | Status |
|------|--------|
| 1 — Schema Migration | Done |
| 2 — Strip CDK | Done |
| 3 — GlueStack | Not started |
| 4 — New Admin Endpoints | Not started |
| 5 — Text Generation Swap | Not started |
| 6 — Frontend | Not started |
