# Security Findings

---

## Critical — Stale Entra Authorization

**Status: Addressed**

Stale Entra Authorization: Cognito will expire the refresh token of user every 24 hours, meaning they'll be forced to login again. Therefore, if they're removed from an Entra group - they'll have stale access for at most 24 hours. User Memberships are only updated when a user logs in, so another way to update user memberships while they're logged in could be running a small CRON job for recently active users. This job may not entirely remain "small" say if we have a few hundred active users recently. I'd say this one is addressed as the practical impact is pretty low.

---

## Critical — SharePoint Item-Level Permissions Are Flattened

**Status: Addressed with documented limitation**

I was not aware that specific items inside a SharePoint list can be restricted to certain users. To properly fix item-level permissions, you would need to store the permitted user_ids alongside group_ids in each chunk's metadata during ingestion, and update the retrieval query to check for overlap against both group_ids and user_ids.

On the ingestion side, the Glue job would call the Graph API per document to detect HasUniqueRoleAssignments, extract the specific Microsoft user IDs that have access, and write them into document_vectors.metadata.

On the retrieval side, when a user authenticates via Cognito, the authorizer would need to resolve and store their Microsoft user ID (from the Entra ID token claims) somewhere in the database so it is available at query time. The retrieve_documents query would then need to filter on both conditions: group membership overlap OR direct user ID match.

This is a non-trivial schema change. It touches the vector metadata structure, the authorizer function, the database (likely a new column or expanded JSONB structure on user_memberships), and the retrieval query in bedrock.py. If not done carefully it introduces normalization issues, particularly around keeping the stored Microsoft user ID in sync with Cognito identity across re-authentications or account changes.

---

## High — Removed SharePoint Sources Remain Searchable

**Status: Addressed — requires periodic sync to take effect**

The Glue ingestion script uses Microsoft's delta token mechanism to detect changes on SharePoint, including deletions and de-scoped lists. However, this sync only takes effect when the ingestion job is run. Admins can trigger it manually from the admin panel or configure an automated schedule — daily, weekly, monthly, or a custom CRON expression of their choosing. As long as ingestion is run on a regular cadence, removed or de-scoped content will be cleaned up within one ingestion cycle.

---

## High — Documented Grounding Verification Does Not Run

**Status: Addressed**

The grounding verifier does run on every response. It only surfaces a warning to the user when it detects a hallucination or insufficiently grounded answer. If no issue is detected the response is returned normally with no warning, which may have given the impression that the check was not executing. No code change is required.

---

## High — SharePoint Document Ingestion May Be Incomplete

**Status: Known limitation — out of scope for current release**

The ingestion pipeline currently covers text-based SharePoint list fields. Document libraries, file attachments, PDFs, Office documents, images, scans, and OCR-derived content are not ingested. To support these, the Glue script would need to be extended to call the SharePoint files API and retrieve binary content, a document parsing layer would be needed for PDFs and Office formats, and OCR would be required for images and scans. The embedding model would also need to be upgraded to Cohere Embed v4 to support multimodal inputs. The database schema would require changes to store raw file references or extracted text. This is a significant refactor that requires careful planning, updated IAM permissions for the Glue role, and thorough end-to-end testing before it can be introduced.

---

## High — Long Conversations Use the Oldest Messages

**Status: Not Addressed**

The `fetch_recent_messages` function in `crud.py` queries chat history with `ORDER BY created_at ASC LIMIT N`. When a conversation exceeds the history limit, this returns the oldest N messages rather than the most recent N, causing the model to lose current conversational context while continuing to reason over stale early messages. The fix is a one-line SQL change: fetch the N most recent messages by ordering descending, then reverse them before passing to the model so they remain in chronological order. The corrected query would be a subquery that selects `ORDER BY created_at DESC LIMIT N` and then wraps it in an outer `ORDER BY created_at ASC`.

---


## High — Full Re-Ingestion Removes the Live Corpus Before Rebuilding

**Status: Not addressed**

When a full re-ingestion is triggered, the current implementation deletes existing indexed content before the replacement ingestion completes. If the Glue job fails partway through, the knowledge base is left empty or incomplete until a subsequent successful run, causing a gap in answer quality. During this window, users will receive no retrieved context and answers will be significantly degraded. The recommended fix is a blue-green approach: write all new content into a staging set of rows tagged with the new run ID, and only swap out (delete) the old content once the new ingestion has completed successfully. This can be implemented by adding a `run_id` column to `document_vectors` and deleting the previous run's rows only after the new run reaches a terminal success state in the `ingestion_runs` table. An alternative approach is to write the new vectors to a separate RDS replica and point the retrieval query at the replica once ingestion completes, then promote it. This fully eliminates downtime since the live instance continues serving queries throughout the rebuild, but it comes at additional cost as it requires running a second database instance for the duration of the ingestion job.
