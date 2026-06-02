# Project Context

## What this is
A RAG application for UBC Science students (Specialization Explorer). Currently uses Bedrock Knowledge Base + OpenSearch Serverless for RAG. We are replacing the entire KB/AOSS pipeline with a custom SharePoint ingestion pipeline using pgvector on RDS Postgres.

## Current stack
- VpcStack — VPC, subnets, NAT gateway, VPC endpoints
- DatabaseStack — RDS Postgres 17.7 on Graviton (t4g.medium), RDS Proxy, Secrets Manager credentials
- DBFlowStack — node-pg-migrate migrations, runs on deploy via TriggerFunction
- ApiGatewayStack — API Gateway REST API (OpenAPI YAML), multiple Lambda functions, Cognito auth for admins, JWT for users, WebSocket API for streaming
- AmplifyStack — frontend hosted on Amplify, connected to GitHub
- KnowledgeBaseStack — Bedrock KB, OpenSearch Serverless, S3 bucket, vector index manager (TO BE REMOVED)
- CICDStack — CodePipeline, ECR, CodeBuild for vector index manager Docker image (TO BE REMOVED)

## What we're doing
Replacing KnowledgeBaseStack + CICDStack with:
- pgvector on existing RDS Postgres (schema migration)
- AWS Glue job for SharePoint ingestion (Graph API → chunk → embed via Titan → upsert pgvector)
- Two new admin Lambda endpoints for triggering ingestion and streaming logs
- Updated text generation Lambda using direct pgvector retrieval instead of bedrock-agent-runtime

## Existing database schema (already deployed, do not touch these tables)
- users
- chat_sessions
- chat_messages
- system_messages
- system_settings
- data_sources
- ingestion_runs (old, from previous pipeline — leave it)

## New tables to add via migration
- sites (id uuid PK, external_site_id text, name text, site_url text, status text, created_at, updated_at)
- site_sources (id uuid PK, site_id FK, source_type text, external_source_id text, name text, source_url text, status text, total_documents int, ingested_documents int, failed_documents int, cursor text, metadata jsonb, created_at, updated_at)
- documents (id uuid PK, site_id FK, source_id FK, document_type text, external_document_id text, title text, source_url text, raw_content jsonb, text_content text, status text, content_hash text, metadata jsonb, created_at, updated_at)
- document_vectors (id uuid PK, document_id FK, chunk_index int, content text, embedding vector(1024), metadata jsonb, created_at)
- ingestion_runs NEW (id uuid PK, site_id FK, source_id FK, run_type text, triggered_by text, status text, started_at, finished_at, total_documents int, processed_documents int, ingested_documents int, skipped_documents int, failed_documents int, error_message text, metadata jsonb)

Note: document_vectors needs ivfflat index on embedding with vector_cosine_ops. pgvector extension must be enabled first.

## Complete database schema (new tables — exact DDL)

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sites (one per SharePoint site)
CREATE TABLE IF NOT EXISTS sites (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_site_id text NOT NULL UNIQUE,
  name text,
  site_url text,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Site sources (one per SharePoint list within a site)
CREATE TABLE IF NOT EXISTS site_sources (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id uuid NOT NULL REFERENCES sites(id),
  source_type text NOT NULL,
  external_source_id text NOT NULL,
  name text,
  source_url text,
  status text DEFAULT 'active',
  total_documents int DEFAULT 0,
  ingested_documents int DEFAULT 0,
  failed_documents int DEFAULT 0,
  cursor text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Documents (one per SharePoint list item)
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id uuid NOT NULL REFERENCES sites(id),
  source_id uuid NOT NULL REFERENCES site_sources(id),
  document_type text NOT NULL,
  external_document_id text NOT NULL,
  title text,
  source_url text,
  raw_content jsonb DEFAULT '{}',
  text_content text,
  status text DEFAULT 'pending',
  content_hash text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Document vectors (one per chunk per document)
CREATE TABLE IF NOT EXISTS document_vectors (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  content text NOT NULL,
  embedding vector(1024),
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Ingestion runs (job history per site/source)
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id uuid REFERENCES sites(id),
  source_id uuid REFERENCES site_sources(id),
  run_type text NOT NULL,
  triggered_by text,
  status text DEFAULT 'pending',
  started_at timestamptz,
  finished_at timestamptz,
  total_documents int DEFAULT 0,
  processed_documents int DEFAULT 0,
  ingested_documents int DEFAULT 0,
  skipped_documents int DEFAULT 0,
  failed_documents int DEFAULT 0,
  error_message text,
  metadata jsonb DEFAULT '{}'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_site_sources_site_id ON site_sources(site_id);
CREATE INDEX IF NOT EXISTS idx_documents_site_id ON documents(site_id);
CREATE INDEX IF NOT EXISTS idx_documents_source_id ON documents(source_id);
CREATE INDEX IF NOT EXISTS idx_documents_external_id ON documents(external_document_id);
CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_document_vectors_document_id ON document_vectors(document_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_runs_site_id ON ingestion_runs(site_id);

-- ivfflat index for cosine similarity search (build after data is loaded)
CREATE INDEX IF NOT EXISTS idx_document_vectors_embedding
  ON document_vectors
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

## Key technical decisions
- Embedding model: amazon.titan-embed-text-v2:0, 1024 dimensions, ca-central-1 on-demand
- Vector similarity: cosine via pgvector <=> operator
- Glue job runs in same VPC as RDS, connects via JDBC
- SharePoint credentials (tenant ID, client ID, client secret) in Secrets Manager
- Glue IAM role needs: Secrets Manager read, Bedrock InvokeModel (Titan), RDS VPC access, CloudWatch logs write
- Log streaming: frontend polls GET /admin/ingestion/logs?jobRunId=xxx every 3-5 seconds, Lambda uses CloudWatch GetLogEvents with nextForwardToken
- Migrations via node-pg-migrate (already in use in DBFlowStack/lambda/db_setup/)
- Region: ca-central-1

## Refactoring order
1. Schema migration — new migration file in cdk/lambda/db_setup/migrations/
2. Strip CDK — remove KnowledgeBaseStack, CICDStack, all references in ApiGatewayStack (knowledgeBaseBucket, knowledgeBaseSecret, lambdaKnowledgeBase, scheduler infrastructure, ECR repos, vectorIndexManager)
3. Glue job + GlueStack — new cdk/lib/glue-stack.ts, new cdk/glue/sharepoint_ingestion.py ported from notebook
4. New Lambda endpoints — POST /admin/ingestion/trigger and GET /admin/ingestion/logs in cdk/lambda/handlers/adminHandler.js, wired into OpenAPI YAML
5. Text generation swap — replace bedrock-agent-runtime.retrieve() in cdk/lambda/textGeneration/helpers/bedrock.py with direct pgvector cosine similarity query via psycopg2
6. Frontend — ingestion trigger button + real-time log window in Amplify frontend

## File structure reference
- CDK stacks: cdk/lib/
- Lambda handlers: cdk/lambda/handlers/
- Text generation: cdk/lambda/textGeneration/helpers/
- Migrations: cdk/lambda/db_setup/migrations/
- OpenAPI definition: cdk/OpenAPI_Swagger_Definition.yaml
- CDK entrypoint: cdk/bin/cdk.ts

## What to preserve
- All Cognito auth logic
- All existing Lambda handlers (adminHandler, userHandler, chatSessionHandler, systemMessagesHandler, textGeneration)
- RDS Proxy connection pattern (all Lambdas connect via RDS_PROXY_ENDPOINT env var)
- JWT token flow for users
- WebSocket streaming for text generation
- WAF rules
- Existing migration files (add new migration, never edit existing ones)

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
