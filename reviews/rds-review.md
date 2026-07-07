# RDS Review — Knowledge Base Assistant

**Scope:** The PostgreSQL data tier — the RDS instance/proxy configuration (`cdk/lib/database-stack.ts`), the migration runner and database role model (`cdk/lambda/db_setup/index.js`), and the SQL schema across the `cdk/lambda/db_setup/migrations/` set — reviewed for security, best practices, and schema design.

**Stack:** PostgreSQL 16.8 on RDS (Graviton `t4g.medium`), fronted by RDS Proxy, with the `vector` (pgvector) and `uuid-ossp` extensions. Schema is managed by `node-pg-migrate` (append-only numbered migrations).

---

## 1. What's Already Good

- **Encryption & transport security.** `storageEncrypted: true` (at rest), a parameter group forcing `rds.force_ssl = 1`, RDS Proxy with `requireTLS: true`, and the migration runner connects with the **RDS CA bundle and `rejectUnauthorized: true`**.
- **Not publicly accessible**, placed in `PRIVATE_ISOLATED` subnets, with `deletionProtection: true` and 7-day automated backups.
- **RDS Proxy** for connection pooling — the correct pattern for Lambda + Postgres.
- **Distinct least-privilege DB roles.** The runner creates `readwrite` (CRUD) and `tablecreator` (CRUD + `CREATE`) roles, maps them to `app_rw`/`app_tc` users, and **rotates their passwords idempotently** into Secrets Manager (plus 30-day hosted rotation in the stack).
- **Solid relational fundamentals.** UUID PKs, `timestamptz` everywhere, `jsonb` metadata, enums for controlled vocabularies, foreign keys, unique constraints (`uq_documents_source_external`, `uq_site_sources_site_external`), and idempotent seeds via `ON CONFLICT`.
- **Access-control normalization.** Migration 018 moved `group_ids` out of a `jsonb` blob into a proper `site_source_access` join table (composite PK, cascading FKs) — a real schema-quality improvement over the earlier metadata approach.
- **Versioned prompts.** `system_messages` is append-only with `unique (type, version)` and an `is_active` flag, enabling rollback.

---

## 2. Instance & Configuration Findings (`database-stack.ts`)

### 2.1 Single-AZ deployment (High for prod — availability)
`multiAz: false`. A single-AZ instance has no automatic failover; an AZ event or instance failure means downtime and potential data loss between backups.

**Recommendation:** Enable `multiAz: true` for production (cost tradeoff), or use a Multi-AZ DB cluster. Keep single-AZ for dev/ephemeral via config.

### 2.2 Storage type and headroom (Medium — cost/perf)
No `storageType` is set, so the instance defaults to **gp2**. `maxAllocatedStorage: 150` gives only 50 GB of autoscaling headroom over the 100 GB allocation — tight for a growing pgvector corpus + chat history.

**Recommendation:** Use `storageType: rds.StorageType.GP3` (better price/throughput and independent IOPS) and raise the autoscaling ceiling.

### 2.3 RDS Proxy connect permission is `*` (Low — least privilege)
The proxy role grants `rds-db:connect` on `resources: ["*"]`.

**Recommendation:** Scope to the specific `arn:aws:rds-db:...:dbuser:<resourceId>/<dbuser>` ARN(s).

### 2.4 Master-credential rotation (Low — verify)
The code rotates the **application** users but a comment claims admin/master rotation "already exists" without a visible schedule in the stack. 

**Recommendation:** Confirm the master secret actually has a rotation schedule; if not, add one (master credentials are the highest-value secret).

### 2.5 Security group exposure (cross-reference)
As noted in `Networking_review.md`, the DB security group allows `5432` from the entire VPC CIDR (including public subnets). That finding applies here too — prefer security-group-referenced ingress from the application tier only.

---

## 3. Migration Runner & Role Model (`db_setup/index.js`)

### 3.1 `readwrite` (the public app user) can DELETE every table (Medium — least privilege)
Both roles receive `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` (with matching default privileges). The public-facing chat/text-gen Lambdas connect as `app_rw`, so a bug or injection in that path could **delete or modify `system_messages`, `system_settings`, `users`, or other users' chat data** — not just the caller's own rows.

**Recommendation:** Tighten the `readwrite` grant set: read-only on configuration tables (`system_messages`, `system_settings`), no `DELETE` on `users`, and table-scoped privileges rather than blanket `ALL TABLES`. Reserve destructive grants for an admin/maintenance role. (Ties to the shared-IAM-role finding in `Lambdas_Review.md`.)

### 3.2 Generated passwords embedded in the SQL string (Low)
User passwords are interpolated into a SQL batch (`format(... %L, '${rwPass}')`). `%L` quotes safely and the passwords are random hex, so this isn't injectable — but the plaintext secret lives in an in-memory SQL string executed under a `console` logger, so any future error/debug logging of that statement would leak credentials.

**Recommendation:** Keep secrets out of logged statement text; run the `CREATE/ALTER USER` separately and never log that statement.

### 3.3 TLS done right here (positive)
Worth highlighting: this runner uses the RDS CA with `rejectUnauthorized: true`, which is **stronger than some application handlers** (e.g., `userHandler.js` sets `rejectUnauthorized: false`). Standardize the app handlers to match this.

---

## 4. Schema Design Findings

### 4.1 Inconsistent `ON DELETE` behavior / cascade strategy (Medium — integrity)
Cascade rules are uneven:
- `document_vectors → documents` has `ON DELETE CASCADE` ✓, and `site_source_access` cascades ✓.
- But `chat_messages → chat_sessions`, `message_ratings`, and `documents → sites/site_sources` FKs were added **without `ON DELETE` actions** (default `NO ACTION`/RESTRICT). So deleting a chat session with messages fails, and document cleanup relies on the Glue job issuing manual `DELETE FROM documents WHERE source_id = …` rather than a DB cascade.

**Recommendation:** Define explicit, consistent `ON DELETE` semantics — `CASCADE` for child rows that should disappear with their parent (chat_messages, ratings, documents under a source), so integrity is enforced by the DB rather than application code.

### 4.2 No CHECK constraints on `system_settings` numeric ranges (Medium — data integrity)
`temperature`, `top_p`, and the various `*_threshold` floats have defaults but **no range validation**. Admin input could persist `temperature = 5` or a negative threshold, silently degrading generation. Range enforcement currently lives only in the application (if at all).

**Recommendation:** Add `CHECK` constraints (e.g., `temperature BETWEEN 0 AND 1`, thresholds `BETWEEN 0 AND 1`, message limits `> 0`). Also consider enforcing the **singleton** `system_settings` row (a unique partial index or a `CHECK (id = <fixed>)` pattern) rather than relying on the seed's `WHERE NOT EXISTS`.

### 4.3 pgvector index: ivfflat built on an empty table, no HNSW (Medium — retrieval quality/perf)
`document_vectors` uses `ivfflat (embedding vector_cosine_ops) WITH (lists = 100)` created in the migration **before any data exists**. ivfflat centroids are computed at build time, so an index built on an empty/early table yields poor clustering and needs a `REINDEX` after the corpus loads. `lists = 100` is also a fixed guess (rule of thumb ≈ rows/1000).

**Recommendation:** Prefer **HNSW** (pgvector ≥ 0.5) for better recall/latency without `lists` tuning and without depending on data-at-build-time; if staying on ivfflat, build/`REINDEX` it after the initial load and size `lists` to the row count.

### 4.4 No index supporting the group-permission filter on retrieval (Medium — perf + access control)
Retrieval filters chunks by `metadata->'group_ids'` (the Entra group access check) combined with vector similarity, but there is **no GIN index** on `document_vectors.metadata` (or a dedicated `group_ids` column). The access-control filter therefore scans rather than using an index — slower as the corpus grows, on the security-sensitive path.

**Recommendation:** Add a GIN index on `document_vectors.metadata` (or extract `group_ids` to an indexed `text[]` column) so the permission filter is index-backed. Given 018 normalized permissions into `site_source_access`, consider filtering via a join to that table instead of the per-chunk `jsonb` copy.

### 4.5 Enum evolution is painful (Low — maintainability)
Migration 006 changes `system_message_type` by swapping the column to `text`, dropping/recreating the type, and casting back — the standard Postgres dance, but fragile and repeated risk as the vocabulary evolves.

**Recommendation:** For frequently-changing vocabularies, consider a lookup/reference table (FK) or `text + CHECK` instead of a hard enum.

### 4.6 Leftover legacy artifacts (Low — cleanup)
Migration 001 renames the original `ingestion_runs` to `ingestion_runs_legacy` and never drops it; the original `data_sources`/`ingestion_runs` design from 000 is superseded by the SharePoint `sites`/`site_sources`/`documents` model. Dead tables add confusion.

**Recommendation:** Once confirmed unused, drop legacy tables in a new migration (append-only — don't edit old ones).

### 4.7 Unbounded growth on chat tables (Low — long-term)
`chat_messages`/`chat_sessions` grow without retention or partitioning for a public, anonymous chat product.

**Recommendation:** Plan a retention policy (and consider monthly partitioning of `chat_messages`) before volume becomes a cost/performance issue.

### 4.8 Document content stored in-row (Informational)
`documents.raw_content`/`text_content` and `document_vectors.content` hold potentially sensitive source content, protected only by storage-level (SSE) encryption. Acceptable, but worth noting given the data classification — column/field-level encryption is an option if the content is sensitive.

---

## 5. Recommendations Summary

| # | Priority | Area | Recommendation |
|---|----------|------|----------------|
| 1 | High (prod) | Availability | Enable Multi-AZ for production (`multiAz: true`). |
| 2 | Medium | Security | Tighten the `readwrite` role — read-only on config tables, no blanket `DELETE`/`ALL TABLES` (3.1). |
| 3 | Medium | Integrity | Define consistent `ON DELETE CASCADE`/`RESTRICT` across all FKs (4.1). |
| 4 | Medium | Integrity | Add `CHECK` constraints for `system_settings` ranges; enforce the singleton row (4.2). |
| 5 | Medium | Perf/Quality | Move to HNSW (or rebuild ivfflat post-load with sized `lists`) (4.3). |
| 6 | Medium | Perf/Security | Add an index backing the group-permission retrieval filter (4.4). |
| 7 | Medium | Cost/Perf | Use `gp3` storage and raise autoscaling headroom (2.2). |
| 8 | Low | Security | Scope RDS Proxy `rds-db:connect` to specific db-user ARNs (2.3). |
| 9 | Low | Security | Confirm master-secret rotation is scheduled (2.4); keep passwords out of logged SQL (3.2). |
| 10 | Low | Maintainability | Drop legacy tables; reconsider enum-as-vocabulary; plan chat-table retention (4.5–4.7). |

---

## 6. What I Did Not Change

This is a review only — no schema or infrastructure was modified. The highest-value items are Multi-AZ for production (1), the `readwrite` privilege tightening (2), and the integrity/validation items (3–4). Note that **all schema changes must be new append-only migrations** per the project convention (never edit an applied migration), and that `ON DELETE`, role-grant, and vector-index changes are behavior-affecting — validate against a copy of production data and roll out via the migration runner.
