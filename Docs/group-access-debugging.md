# Group Access Debugging — Vector Search Returns No Results

## Problem
Text generation returned no results for an admin user even though the SharePoint lists were ingested successfully and chunks existed in `document_vectors`.

## Root Cause
The access control system works purely on **Entra group membership**. The Glue ingestion script reads each SharePoint list's explicit permissions, extracts the Entra group IDs that have access, and tags every chunk's metadata with those group IDs. At query time, text gen filters `document_vectors` using a `?|` overlap check between the user's Entra groups and the chunk's `group_ids`.

The admin user belonged to `All Company`, `UBC CIC`, and `mock-site` — but none of those groups were granted access to the ingested lists. The lists were only accessible to `bcbbfa7e` (Top Secret Group) and `cdb743a3`. No overlap = no results.

Being a SharePoint site admin gives you UI-level access to lists but the Glue script only reads explicit permission grants — admin elevation is invisible to it.

## How We Debugged It

1. Queried `document_vectors` to see what group IDs were tagging the chunks
2. Ran a Graph API test script (`client_credentials` → `GET /v1.0/users/{email}/transitiveMemberOf`) to get the user's Entra group memberships
3. Compared the two — no overlap
4. Confirmed via `site_sources` which lists were tagged with those group IDs
5. Checked SharePoint list permissions — confirmed only those two Entra groups had explicit access

## Fix
Add the user to one of the Entra groups that has access to the ingested lists (`bcbbfa7e` or `cdb743a3`) in Azure Portal → Groups → Members → Add.

## Bottom Line
**You must be a member of an Entra group that is explicitly granted access to a SharePoint list.** SharePoint site groups (Owners, Members, Visitors) are expanded by the Glue script to find the Entra groups nested inside them — membership in the SharePoint group itself is not enough, it's the underlying Entra group that matters.
