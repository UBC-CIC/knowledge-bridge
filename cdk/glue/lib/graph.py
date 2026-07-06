"""
Microsoft Graph API and SharePoint REST helpers.

Provides token caching, auth header factories, retry-aware HTTP GET, delta-sync
pagination, and async Graph SDK wrappers. All credential objects are injected —
no module-level Azure/Graph state except the token cache (job-scoped).

GraphContext dataclass bundles the four runtime dependencies so downstream
modules (permissions, orchestration) can take a single ctx argument.
"""

import re
import time
import logging
from dataclasses import dataclass
from typing import Any, Callable, Optional
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

GUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

_TOKEN_CACHE: dict = {}
_TOKEN_REFRESH_BUFFER = 300

_GRAPH_REQUEST_TIMEOUT = 30
_GRAPH_MAX_RETRIES = 5


@dataclass
class GraphContext:
    get_graph_headers: Callable[[], dict]
    get_sharepoint_headers: Callable[[str], dict]
    resolve_site_url: Callable      # async: (site_id) -> str
    graph_client: Any


def get_cached_token(credential_obj, namespace: str, scope: str) -> str:
    key = (namespace, scope)
    now = int(time.time())
    cached = _TOKEN_CACHE.get(key)
    if cached and getattr(cached, "expires_on", 0) > now + _TOKEN_REFRESH_BUFFER:
        return cached.token
    fresh = credential_obj.get_token(scope)
    _TOKEN_CACHE[key] = fresh
    return fresh.token


def make_graph_headers_fn(credential) -> Callable[[], dict]:
    def get_graph_headers() -> dict:
        token = get_cached_token(credential, "graph", "https://graph.microsoft.com/.default")
        return {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    return get_graph_headers


def make_sharepoint_headers_fn(rest_credential) -> Callable[[str], dict]:
    def get_sharepoint_headers(site_url: str) -> dict:
        parsed = urlparse(site_url)
        scope = f"{parsed.scheme}://{parsed.netloc}/.default"
        token = get_cached_token(rest_credential, "sharepoint", scope)
        return {"Authorization": f"Bearer {token}", "Accept": "application/json;odata=nometadata"}
    return get_sharepoint_headers


def _graph_get(url: str, headers: dict) -> requests.Response:
    """GET with timeout and 429/5xx backoff honoring Retry-After."""
    for attempt in range(_GRAPH_MAX_RETRIES):
        resp = requests.get(url, headers=headers, timeout=_GRAPH_REQUEST_TIMEOUT)
        if resp.status_code == 429 or resp.status_code >= 500:
            retry_after = int(resp.headers.get("Retry-After", 2 ** attempt))
            wait = min(retry_after, 60)
            logger.warning(f"Graph returned {resp.status_code}; retrying in {wait}s (attempt {attempt + 1}/{_GRAPH_MAX_RETRIES})")
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp
    resp.raise_for_status()
    return resp


def fetch_list_changes(site_id: str, list_id: str, get_headers_fn: Callable[[], dict], existing_delta_link=None):
    url = existing_delta_link or f"https://graph.microsoft.com/v1.0/sites/{site_id}/lists/{list_id}/items/delta?expand=fields"
    all_changes, delta_link = [], None
    while url:
        resp = _graph_get(url, get_headers_fn())
        data = resp.json()
        all_changes.extend(data.get("value", []))
        url = data.get("@odata.nextLink")
        delta_link = data.get("@odata.deltaLink") or delta_link
    return all_changes, delta_link


async def resolve_site_url(site_id: str, graph_client) -> str:
    from msgraph.generated.sites.item.site_item_request_builder import SiteItemRequestBuilder
    site = await graph_client.sites.by_site_id(site_id).get(
        request_configuration=SiteItemRequestBuilder.SiteItemRequestBuilderGetRequestConfiguration(
            query_parameters=SiteItemRequestBuilder.SiteItemRequestBuilderGetQueryParameters(
                select=["webUrl"]
            )
        )
    )
    url = site.web_url
    if not url:
        raise RuntimeError(f"No webUrl for site {site_id}")
    return url.rstrip("/")


async def get_column_mapping(site_id: str, list_id: str, graph_client) -> dict:
    columns = await graph_client.sites.by_site_id(site_id).lists.by_list_id(list_id).columns.get()
    return {col.name: col.display_name for col in columns.value if col.name and col.display_name}
