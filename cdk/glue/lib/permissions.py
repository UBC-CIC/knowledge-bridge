"""
SharePoint and Entra permission resolution.

Resolves which Entra group IDs are authorised to access a given SharePoint list,
handling both inherited and list-specific permission grants, and expanding
SharePoint site groups to their underlying Entra group members.

All Graph/SharePoint calls are made through the injected GraphContext so this
module has no module-level credential state.
"""

import logging
from typing import Optional

import httpx

from graph import GraphContext, GUID_RE

logger = logging.getLogger(__name__)


async def get_site_backing_group_id(site_id: str, ctx: GraphContext) -> Optional[str]:
    try:
        site_url = await ctx.resolve_site_url(site_id, ctx.graph_client)
        headers = ctx.get_sharepoint_headers(site_url)
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{site_url}/_api/web/allproperties", headers=headers)
            resp.raise_for_status()
            data = resp.json()
        gid = data.get("GroupId") or data.get("groupId")
        return gid.lower() if gid else None
    except Exception as e:
        logger.warning(f"Could not get site backing group: {e}")
        return None


async def expand_sharepoint_group(site_id: str, sp_group_id: int, ctx: GraphContext, visited=None) -> set:
    visited = visited or set()
    if sp_group_id in visited:
        return set()
    visited.add(sp_group_id)
    site_url = await ctx.resolve_site_url(site_id, ctx.graph_client)
    headers = ctx.get_sharepoint_headers(site_url)
    found = set()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"{site_url}/_api/web/SiteGroups/GetById({sp_group_id})/Users",
                headers=headers,
            )
            resp.raise_for_status()
            members = resp.json().get("value", [])
        for m in members:
            login = m.get("LoginName", "")
            guids = GUID_RE.findall(login)
            if guids:
                found.add(guids[-1].lower())
            elif "sitegroup" in login.lower():
                nested_guids = GUID_RE.findall(login)
                if nested_guids:
                    try:
                        nested = await expand_sharepoint_group(site_id, int(nested_guids[-1]), ctx, visited)
                        found.update(nested)
                    except Exception:
                        pass
    except Exception as e:
        logger.warning(f"expand_sharepoint_group failed for group {sp_group_id}: {e}")
    return found


async def list_inherits_permissions(site_id: str, list_id: str, ctx: GraphContext) -> bool:
    headers = ctx.get_graph_headers()
    url = f"https://graph.microsoft.com/v1.0/sites/{site_id}/lists/{list_id}?$select=sharepointIds"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    return any("inheritedFrom" in perm for perm in data.get("value", []))


async def get_list_authorized_groups(site_id: str, list_id: str, ctx: GraphContext) -> list:
    try:
        site_backing_group_id = await get_site_backing_group_id(site_id, ctx)
        inherits = await list_inherits_permissions(site_id, list_id, ctx)
        headers = ctx.get_graph_headers()
        if inherits:
            url = f"https://graph.microsoft.com/v1.0/sites/{site_id}/permissions"
        else:
            url = f"https://graph.microsoft.com/beta/sites/{site_id}/lists/{list_id}/permissions"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            perm_resp = resp.json()
        permissions = perm_resp.get("value", [])
        authorized: set = set()
        for perm in permissions:
            granted = perm.get("grantedToV2", {})
            group_obj = granted.get("group")
            if group_obj:
                gid = group_obj.get("id")
                if gid:
                    gid = gid.lower()
                    if gid != site_backing_group_id:
                        authorized.add(gid)
                continue
            site_group = granted.get("siteGroup")
            if site_group:
                sp_gid = site_group.get("id")
                if sp_gid is not None:
                    expanded = await expand_sharepoint_group(site_id, int(sp_gid), ctx)
                    if site_backing_group_id:
                        expanded.discard(site_backing_group_id)
                    authorized.update(expanded)
        logger.info("[AUTH] Resolved %d authorized groups for list %s", len(authorized), list_id)
        return list(authorized)
    except Exception as e:
        logger.error(f"[AUTH] get_list_authorized_groups failed: {e}", exc_info=True)
        return []


async def upsert_entra_groups(group_ids: list, ctx: GraphContext, conn) -> None:
    """Fetch display names for group_ids from Graph and upsert into entra_groups."""
    if not group_ids:
        return
    headers = ctx.get_graph_headers()
    rows = []
    async with httpx.AsyncClient(timeout=30) as client:
        for gid in group_ids:
            try:
                resp = await client.get(
                    f"https://graph.microsoft.com/v1.0/groups/{gid}?$select=id,displayName",
                    headers=headers,
                )
                resp.raise_for_status()
                data = resp.json()
                rows.append((gid, data.get("displayName") or gid))
            except Exception as e:
                logger.warning(f"[AUTH] Could not fetch display name for group {gid}: {e}")
                rows.append((gid, gid))
    if not rows:
        return
    try:
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO entra_groups (id, display_name)
                VALUES (%s, %s)
                ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name
                """,
                rows,
            )
        conn.commit()
        logger.info("[AUTH] Upserted %d groups into entra_groups", len(rows))
    except Exception as e:
        logger.error(f"[AUTH] upsert_entra_groups DB write failed: {e}")
