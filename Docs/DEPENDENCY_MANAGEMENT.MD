# Dependency Management Guide

## Overview

This document explains how Python dependencies are managed for the AWS Glue ingestion job — the only Python workload in this project that requires explicit dependency management.

The `textGeneration` Lambda (Python 3.12) relies on pre-built Lambda layers (`psycopg2`, etc.) and does not use a pip-tools workflow.

---

## Glue Ingestion Job

**Location:** `cdk/glue/sharepoint_ingestion.py`
**Runtime:** Python 3.9, Glue 3.0 Shell

The Glue job's dependencies are declared in `cdk/glue/requirements.txt`. At deploy time, the `GlueStack` CDK stack uploads this file to S3 and passes it to the Glue job via the `--additional-python-modules` job parameter. Glue installs the packages automatically before each run.

### Current Dependencies (`cdk/glue/requirements.txt`)

| Package | Pinned Version | Purpose |
|---------|---------------|---------|
| `boto3` | 1.35.0 | AWS SDK (Bedrock, Secrets Manager, S3) |
| `botocore` | 1.35.0 | AWS SDK core |
| `azure-identity` | 1.21.0 | Entra ID credential provider for Graph API auth |
| `msgraph-sdk` | 1.27.0 | Microsoft Graph API client (SharePoint access) |
| `psycopg2-binary` | 2.9.9 | PostgreSQL driver for pgvector upserts |
| `httpx` | 0.27.0 | HTTP client (required by msgraph-sdk) |

> **Note on boto3/botocore pinning:** Glue 3.0 ships with boto3 ~1.26.x, which predates `bedrock-runtime` (added in 1.28.57). Both are pinned to 1.35.0 to ensure Bedrock calls work correctly.

---

## Adding a New Dependency

1. Add the package and version to `cdk/glue/requirements.txt`:

   ```
   some-package==1.2.3
   ```

2. Redeploy the GlueStack:

   ```bash
   cd cdk
   cdk deploy GlueStack
   ```

   The CDK stack uploads the updated `requirements.txt` to S3 and the next Glue job run will install the new package.

3. Verify by triggering a test ingestion run from the admin dashboard and checking the CloudWatch log group for the Glue job.

---

## Updating an Existing Dependency

1. Update the pinned version in `cdk/glue/requirements.txt`.
2. Redeploy: `cdk deploy GlueStack`.
3. Test by triggering an ingestion run.

> Always pin to an exact version (`==`) rather than a range (`>=`). Glue 3.0 has a fixed Python 3.9 runtime and dependencies are resolved fresh on each run — unpinned versions can silently introduce regressions if a new release is published between runs.
