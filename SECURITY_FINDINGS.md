# Security Findings Assessment

## Critical 1 — Stale Entra Authorization

**Finding:** A disabled/removed user may retain access for up to ~30 days via existing Cognito sessions.

**Current state: Partially mitigated.**

What we have:
- Refresh token is now 1 day (`refreshTokenValidity: Duration.days(1)` in `api-stack.ts`)
- PostAuthentication trigger (`addUserOnSignUp.js`) syncs the user's Entra group memberships into the `user_memberships` DB table on every login
- At each chat request, `get_user_groups(user_id, db_connection)` fetches groups live from the DB (not from the JWT), and `retrieve_documents` filters vectors by those group IDs

**What's fixed:** The original 30-day exposure window is reduced to 24 hours. If a user is removed from the Entra **tenant entirely**, Microsoft will block re-authentication after their refresh token expires (≤24h), and they'll be signed out.

**Remaining gap:** If a user is removed from an **Entra group** (but stays in the tenant), their `user_memberships` row in the DB is only refreshed on their next login. They can continue to retrieve documents from that group for up to 24 hours. Cognito and the DB have no way to know about the group removal between logins.

**To fully fix:** Add a periodic background job (EventBridge + Lambda) that re-runs the group sync from Entra for all users active in the last N hours. This would close the stale-group window without requiring a forced re-login.

---

## Critical 2 — SharePoint Item-Level Permissions Are Flattened

**Finding:** Restricted items inherit the broader permissions of their containing list, allowing users to retrieve content SharePoint itself would deny.

**Current state: Not addressed.**

What we have:
- `retrieve_documents` in `bedrock.py` does filter by `(v.metadata->'group_ids') ?| %s` — so there IS Entra group-based access control at retrieval time
- But `group_ids` stored in `document_vectors.metadata` comes from the SharePoint **list-level** permissions set during ingestion, not per-item permissions

**The gap:** SharePoint supports unique (broken inheritance) permissions on individual list items. If an item has been restricted to a subset of users or a different group from its parent list, the ingestion pipeline still stores the parent list's group IDs against that item's vectors. Any user with list-level access can retrieve it.

**To fix:** In the Glue ingestion job, for each SharePoint list item, call the Graph API to check if it has unique permissions (`GET /sites/{site}/lists/{list}/items/{item}/driveItem/permissions` or the equivalent list item permissions endpoint). If it does, use those item-level group IDs in `document_vectors.metadata.group_ids` instead of the list-level ones. This requires an additional Graph API call per document but is the only correct fix.
