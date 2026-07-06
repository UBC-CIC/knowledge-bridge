# Glue Review — Knowledge Base Assistant

**Scope:** The AWS Glue components — the infrastructure definition (`cdk/lib/glue-stack.ts`) and the ingestion job script (`cdk/glue/sharepoint_ingestion.py`) — reviewed for best practices, security, maintainability, and code quality.

**What Glue does here:** A Python-shell Glue job pulls SharePoint list items via Microsoft Graph, narrates each item into a paragraph with Claude Haiku, embeds it with Cohere, and upserts documents + pgvector embeddings into PostgreSQL. It also resolves SharePoint/Entra group permissions per list and stores them for retrieval-time access control.

---

## 1. What's Already Good

- **Parameterized SQL everywhere.** Every `cur.execute` uses `%s` placeholders (and `execute_values`/`executemany`); no string-interpolated SQL — no injection surface in the job.
- **Idempotent, incremental design.** Content hashing skips unchanged documents, a Graph `deltaLink` cursor drives incremental syncs, and upserts use `ON CONFLICT`. This makes retries and re-runs safe.
- **Per-item fault isolation.** Each list item is processed in its own `try/except`, failures are counted and recorded, and one bad item doesn't abort the run. A `verify_source_ingestion_success` step double-checks results.
- **Reasonably scoped IAM (stack).** The Glue role grants specific secret ARNs, specific Bedrock model ARNs, `/aws-glue/*` logs, and the glue-assets S3 prefix — not blanket `*` on those services. DB secret access is via `grantRead`.
- **Permission propagation without re-embedding.** Group-permission changes update `document_vectors.metadata` directly rather than triggering costly re-embedding — a thoughtful optimization.
- **Token caching** with a refresh buffer for both Graph and SharePoint REST credentials.

---

## 2. Infrastructure Findings (`glue-stack.ts`)

### 2.1 Dependencies pinned inline via `--additional-python-modules` (Medium — maintainability)
The job installs `boto3==1.34.0,botocore==1.34.0,azure-identity==...,msgraph-sdk==...,psycopg2-binary==...,httpx==...,requests==...` as a Glue default argument string.

- Pinning **boto3 1.34.0** can conflict with the Glue-provided SDK and may **lack newer Bedrock model/runtime support** the job relies on.
- An inline comma-separated string is brittle and bypasses the project's stated dependency workflow (pip-tools `requirements.in` → `requirements.txt`, per `Docs/DEPENDENCY_MANAGEMENT.MD`).

**Recommendation:** Manage these deps through a pinned `requirements`-style file and let boto3/botocore come from the Glue runtime (or pin to a current version) so Bedrock features stay available.

### 2.2 Runtime version (Low — maintainability)
The job is `pythonshell` / Python 3.9 with `glueVersion: "3.0"`. Python 3.9 is the older Python-shell runtime.

**Recommendation:** Move to the current supported Python-shell runtime so you stay on a maintained interpreter and library baseline.

### 2.3 No retries on a job that is safe to retry (Low)
`maxRetries: 0`. The job is idempotent (content hash + delta cursor + upserts), so transient Graph/Bedrock/DB failures are safe to retry automatically.

**Recommendation:** Set `maxRetries: 1` (or 2) to absorb transient failures without manual re-runs.

### 2.4 Glue role IAM (Low — acceptable)
`AWSGlueServiceRole` (managed) plus ENI/`ec2:Describe*` on `*` are required by Glue VPC connections and are acceptable. The custom statements are already scoped. No change needed beyond awareness.

---

## 3. Script Security Findings (`sharepoint_ingestion.py`)

### 3.1 SharePoint content (and field maps) logged to CloudWatch (Medium — privacy)
`narrate_fields` logs `clean_fields` and the generated `narrative`, and other spots log `name_map` and per-item content. For a knowledge base that may hold sensitive institutional/survey data, writing **document content** to CloudWatch Logs at INFO is a data-exposure concern and conflicts with the product's privacy posture.

**Recommendation:** Log identifiers and counts, not content. Drop the `Cleaned Fields`/`Narrative`/field-map content logs (or guard them behind a debug flag and a short log retention).

### 3.2 `requests.get` calls have no timeout (Medium — reliability)
`fetch_list_changes` uses `requests.get(url, headers=headers)` with **no timeout**, and the Bedrock `invoke_model` calls rely on default client timeouts. The async `httpx` calls correctly use `timeout=30`, so the codebase is inconsistent. A hung Graph endpoint can block until the 120-minute job timeout.

**Recommendation:** Add explicit timeouts to all `requests`/Bedrock calls (and standardize on one HTTP client — see 5.3).

### 3.3 No throttling/backoff for Microsoft Graph (Medium — reliability)
`fetch_list_changes` paginates `@odata.nextLink` with no handling for Graph **429 / `Retry-After`** throttling, which Graph applies aggressively at scale. A throttle currently surfaces as a hard `raise_for_status()` failure.

**Recommendation:** Honor `Retry-After` with bounded exponential backoff on 429/5xx for Graph and SharePoint REST calls.

### 3.4 Permission-inheritance check may always evaluate false (Medium — verify, access-control-sensitive)
`list_inherits_permissions` requests a **single list object** with `$select=sharepointIds` but then reads `data.get("value", [])` — a single resource response has no `value` array, so this likely always returns `False`, forcing the non-inherited permission branch for every list. Because the result drives which Entra groups are authorized for a source (and therefore who can retrieve it), an incorrect branch could **over- or under-expose** content.

**Recommendation:** Verify this against real Graph responses and fix the response shape handling. Treat anything affecting `site_source_access` as security-critical and add a test.

---

## 4. Script Code-Quality & Correctness Findings

### 4.1 A new DB connection per helper call — and per document step (High — performance + correctness)
`get_db_conn()` opens a **brand-new psycopg2 connection** on essentially every helper invocation. Worse, `upsert_document_and_vectors` opens **four to five separate connections/transactions for a single document** (insert doc → re-read hash → count vectors → delete vectors → insert vectors).

Two problems:
- **Performance:** processing N items opens thousands of short-lived connections through RDS Proxy — high overhead and proxy churn.
- **Correctness/atomicity:** splitting one logical document write across multiple transactions means a failure between steps can leave **partial state** (e.g., the document row marked `ingested` while its vectors were deleted but not re-inserted).

**Recommendation:** Open one connection (or a small pool) for the job and reuse it; make each document's write a **single transaction** so it commits or rolls back atomically.

### 4.2 Embeddings generated one chunk at a time (Medium — cost + performance)
`embed_text` calls Bedrock with a single text per `invoke_model`. Cohere Embed supports **batching multiple texts per request**.

**Recommendation:** Batch chunk embeddings per document (or per N chunks) to cut Bedrock call count, latency, and cost.

### 4.3 Inaccurate site-level metrics (Medium — observability)
In `run_site_ingestion`: `total_ingested += result.get("processed",0) - result.get("failed",0)` counts **skipped** items as ingested, and `total_skipped += 0` is hardcoded to zero (the per-list result never returns a skipped count). Reported ingestion stats are therefore wrong.

**Recommendation:** Return and aggregate a real `skipped` count, and compute `ingested = processed − failed − skipped`.

### 4.4 Dead/confusing SQL (Low)
In `upsert_document_and_vectors`: `status = CASE WHEN documents.content_hash = EXCLUDED.content_hash THEN 'ingested' ELSE 'ingested' END` always yields `'ingested'`.

**Recommendation:** Replace with a plain `status = 'ingested'` (or implement the intended branch). Several `refresh_source_counts` CASE arms similarly all return `'active'`.

### 4.5 Deprecated async entrypoint + blocking calls in async functions (Low)
The entrypoint uses `asyncio.get_event_loop().run_until_complete(...)` (deprecated since 3.10), and the `async def` ingestion functions call **synchronous** psycopg2 and Bedrock APIs, blocking the event loop. Concurrency isn't actually exploited (everything is awaited sequentially), so the async layer adds complexity without benefit.

**Recommendation:** Use `asyncio.run(...)`. Either commit to true concurrency (e.g., gather list processing with bounded parallelism) or drop async for the synchronous DB/Bedrock paths.

### 4.6 Module-level side effects at import (Low — testability)
Secret fetches, a DB test connection, and client construction all run at **module top level**. This makes the script impossible to import/unit-test without live AWS, and any failure is fatal at load.

**Recommendation:** Move initialization into a `main()` / `if __name__ == "__main__":` guard and pass dependencies in.

---

## 5. Maintainability

### 5.1 Monolithic 941-line script with no tests (Medium)
The job is a single file mixing Graph access, SharePoint REST, permission resolution, chunking, embedding, narration, and ~20 DB helpers — clearly ported straight from the origin notebook. There are no unit tests.

**Recommendation:** Split into focused modules (e.g., `graph.py`, `permissions.py`, `db_repo.py`, `chunking.py`, `embedding.py`, `narration.py`) and add unit tests for the pure logic (chunking, field cleaning, UPN/group parsing, metrics math) and the permission-resolution path.

### 5.2 Three HTTP stacks (Low)
The script uses `requests` (sync), `httpx` (async), and the `msgraph` SDK simultaneously.

**Recommendation:** Standardize on one HTTP approach (the `msgraph` SDK plus a single client for raw REST) to reduce dependency surface and inconsistent timeout/retry behavior.

### 5.3 LLM-narrated content is what gets indexed (Low — design note)
Every list item incurs a Haiku narration call, and the **LLM-rewritten** paragraph (not the source text) is embedded and later retrieved. This is a per-item Bedrock cost driver and a place where narration errors/hallucinations can propagate into the knowledge base.

**Recommendation:** Confirm this is intentional; consider storing/embedding the structured source text alongside the narration, and monitor narration cost as list volume grows.

---

## 6. Recommendations Summary

| # | Priority | Area | Recommendation |
|---|----------|------|----------------|
| 1 | High | Perf/Correctness | Reuse one DB connection; make each document write a single atomic transaction (4.1). |
| 2 | Medium | Security/Privacy | Stop logging SharePoint content/field maps/narratives to CloudWatch (3.1). |
| 3 | Medium | Security (verify) | Verify/fix `list_inherits_permissions` response handling — it gates access control (3.4). |
| 4 | Medium | Reliability | Add timeouts to all `requests`/Bedrock calls (3.2); add Graph 429/`Retry-After` backoff (3.3). |
| 5 | Medium | Cost/Perf | Batch Cohere embeddings instead of one call per chunk (4.2). |
| 6 | Medium | Observability | Fix site-level ingested/skipped metric math (4.3). |
| 7 | Medium | Maintainability | Manage Python deps via pip-tools; don't pin old boto3 inline (2.1); split the monolith + add tests (5.1). |
| 8 | Low | Reliability | Set `maxRetries: 1–2` on the idempotent job (2.3). |
| 9 | Low | Code quality | Remove dead CASE expressions (4.4); use `asyncio.run`; init under `main()` (4.5, 4.6). |
| 10 | Low | Maintainability | Upgrade the Python-shell runtime (2.2); consolidate HTTP clients (5.2). |

---

## 7. What I Did Not Change

This is a review only — no code or infrastructure was modified. The highest-value items are 1 (connection reuse + atomic writes — both a performance and a data-integrity fix) and the security/access-control items 2–4. Note that the permission-inheritance fix (item 3) affects who can retrieve which content, so validate it against real Graph responses and the `site_source_access` data before deploying.
