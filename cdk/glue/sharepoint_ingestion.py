"""
SharePoint → pgvector ingestion job.
Ported from the Revised GraphAPI Custom Ingestion notebook.

Job parameters (passed at runtime or from Glue defaults):
  --SHAREPOINT_SECRET_NAME   : KBA-SharePoint-Credentials
  --SHAREPOINT_CERT_SECRET   : Sharepoint-REST-Cert-Pfx-B64
  --SHAREPOINT_CERT_PASSWORD_SECRET : Sharepoint-REST-Cert-Pfx-Password
  --DB_SECRET_NAME           : <secretPathUser secret name>
  --RDS_PROXY_ENDPOINT       : <rds proxy endpoint>
  --FORCE_FULL               : "true" | "false"
  --TRIGGERED_BY             : "manual" | "scheduled" | "system"
"""

import sys
import json
import re
import base64
import hashlib
import asyncio
import logging
import time
from urllib.parse import urlparse
from typing import Optional

import boto3
import psycopg2
import psycopg2.extras
from botocore.config import Config
from azure.identity import ClientSecretCredential, CertificateCredential
from msgraph import GraphServiceClient
from msgraph.generated.sites.item.site_item_request_builder import SiteItemRequestBuilder
import httpx

from awsglue.utils import getResolvedOptions

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
import os
os.environ["PYTHONUNBUFFERED"] = "1"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    stream=sys.stderr,
    force=True,
)
logger = logging.getLogger("SharePointIngestion")

def log(msg):
    """Print to stdout flushed — reliably captured by Glue CloudWatch output stream."""
    print(msg, flush=True)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
REGION = "ca-central-1"
LLM_REGION = "us-west-2"
EMBEDDING_MODEL_ID = "cohere.embed-english-v3"
EMBEDDING_DIM = 1024
COHERE_BATCH_SIZE = 96

GUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

SYSTEM_JUNK = {
    "AppAuthor", "AppEditor", "Attachments", "ColorTag", "_ColorTag",
    "ComplianceAssetId", "ContentType", "Edit", "FolderChildCount",
    "ID", "ItemChildCount", "_IsRecord", "LinkTitle", "LinkTitleNoMenu",
    "DocIcon", "_UIVersionString", "FileSystemObjectType", "LabelSetting", "RetentionLabel",
}

# ---------------------------------------------------------------------------
# Job parameters — resolved at module level (required by Glue runtime)
# ---------------------------------------------------------------------------
args = getResolvedOptions(sys.argv, [
    "SHAREPOINT_SECRET_NAME",
    "SHAREPOINT_CERT_SECRET",
    "SHAREPOINT_CERT_PASSWORD_SECRET",
    "DB_SECRET_NAME",
    "RDS_PROXY_ENDPOINT",
    "FORCE_FULL",
    "TRIGGERED_BY",
    "INGESTION_RUN_ID",
])

SHAREPOINT_SECRET_NAME = args["SHAREPOINT_SECRET_NAME"]
SHAREPOINT_CERT_SECRET = args["SHAREPOINT_CERT_SECRET"]
SHAREPOINT_CERT_PASSWORD_SECRET = args["SHAREPOINT_CERT_PASSWORD_SECRET"]
DB_SECRET_NAME = args["DB_SECRET_NAME"]
RDS_PROXY_ENDPOINT = args["RDS_PROXY_ENDPOINT"]
FORCE_FULL = args.get("FORCE_FULL", "false").lower() == "true"
TRIGGERED_BY = args.get("TRIGGERED_BY", "manual")
INGESTION_RUN_ID = args.get("INGESTION_RUN_ID")

# ---------------------------------------------------------------------------
# Token cache
# ---------------------------------------------------------------------------
_TOKEN_CACHE: dict = {}
_TOKEN_REFRESH_BUFFER = 300

def get_cached_token(credential_obj, namespace: str, scope: str) -> str:
    key = (namespace, scope)
    now = int(time.time())
    cached = _TOKEN_CACHE.get(key)
    if cached and getattr(cached, "expires_on", 0) > now + _TOKEN_REFRESH_BUFFER:
        return cached.token
    fresh = credential_obj.get_token(scope)
    _TOKEN_CACHE[key] = fresh
    return fresh.token

# These are set in main() — declared here so helpers can reference them as module globals.
credential = None
rest_credential = None
graph_client = None
SITE_ID = None

def get_graph_headers() -> dict:
    token = get_cached_token(credential, "graph", "https://graph.microsoft.com/.default")
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}

def get_sharepoint_headers(site_url: str) -> dict:
    parsed = urlparse(site_url)
    scope = f"{parsed.scheme}://{parsed.netloc}/.default"
    token = get_cached_token(rest_credential, "sharepoint", scope)
    return {"Authorization": f"Bearer {token}", "Accept": "application/json;odata=nometadata"}

# ---------------------------------------------------------------------------
# AWS clients — set in main()
# ---------------------------------------------------------------------------
secrets_client = None
bedrock_runtime = None
bedrock_llm = None

def get_secret(secret_id: str) -> str:
    return secrets_client.get_secret_value(SecretId=secret_id)["SecretString"]

# ---------------------------------------------------------------------------
# DB connection — one connection reused for the job lifetime
# ---------------------------------------------------------------------------
_JOB_CONN = None

def _open_db_conn():
    secret = json.loads(get_secret(DB_SECRET_NAME))
    return psycopg2.connect(
        host=RDS_PROXY_ENDPOINT,
        port=secret.get("port", 5432),
        dbname=secret.get("dbname", "kba"),
        user=secret["username"],
        password=secret["password"],
        sslmode="require",
    )

def get_conn():
    global _JOB_CONN
    if _JOB_CONN is None or _JOB_CONN.closed:
        _JOB_CONN = _open_db_conn()
    return _JOB_CONN

# ---------------------------------------------------------------------------
# Graph helpers — retry with Retry-After backoff on 429
# ---------------------------------------------------------------------------
async def http_get_with_retry(url, headers, timeout=30, max_retries=3):
    for attempt in range(max_retries):
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 10))
            log(f"Graph 429 — waiting {wait}s (attempt {attempt + 1}/{max_retries})")
            await asyncio.sleep(min(wait, 60))
            headers = get_graph_headers()
            continue
        resp.raise_for_status()
        return resp
    raise RuntimeError(f"Graph request failed after {max_retries} retries: {url}")

# ---------------------------------------------------------------------------
# Cursor helpers
# ---------------------------------------------------------------------------
def get_source_cursor(source_id: str) -> Optional[str]:
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("SELECT cursor FROM site_sources WHERE id = %s", (source_id,))
        row = cur.fetchone()
    return row[0] if row else None

def save_source_cursor(source_id: str, cursor: str):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("UPDATE site_sources SET cursor = %s, updated_at = now() WHERE id = %s", (cursor, source_id))
    conn.commit()

# ---------------------------------------------------------------------------
# Site / source / document DB helpers
# ---------------------------------------------------------------------------
def upsert_site(external_site_id: str, name: Optional[str], site_url: Optional[str]) -> str:
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO sites (external_site_id, name, site_url, status, updated_at)
            VALUES (%s, %s, %s, 'active', now())
            ON CONFLICT (external_site_id)
            DO UPDATE SET name = EXCLUDED.name, site_url = EXCLUDED.site_url, updated_at = now()
            RETURNING id
        """, (external_site_id, name, site_url))
        site_id = cur.fetchone()[0]
    conn.commit()
    return str(site_id)

def upsert_site_source(site_id, source_type, external_source_id, name, source_url, total_documents, group_ids) -> str:
    new_group_set = {g.lower() for g in group_ids if g}

    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO site_sources (site_id, source_type, external_source_id, name, source_url, total_documents, status, metadata, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, 'active', '{}'::jsonb, now())
            ON CONFLICT (site_id, external_source_id)
            DO UPDATE SET name = EXCLUDED.name, source_url = EXCLUDED.source_url,
                total_documents = EXCLUDED.total_documents, updated_at = now()
            RETURNING id
        """, (site_id, source_type, external_source_id, name, source_url, total_documents))
        source_id = str(cur.fetchone()[0])

        cur.execute("""
            SELECT entra_group_id FROM site_source_access WHERE site_source_id = %s
        """, (source_id,))
        old_group_set = {row[0] for row in cur.fetchall()}

        added = new_group_set - old_group_set
        removed = old_group_set - new_group_set

        if added:
            psycopg2.extras.execute_values(cur, """
                INSERT INTO site_source_access (site_source_id, entra_group_id)
                VALUES %s ON CONFLICT DO NOTHING
            """, [(source_id, gid) for gid in added])

        if removed:
            cur.execute("""
                DELETE FROM site_source_access
                WHERE site_source_id = %s AND entra_group_id = ANY(%s)
            """, (source_id, list(removed)))

    conn.commit()

    # Propagate permission changes to all chunks for this source — no re-embed needed
    if added or removed:
        new_group_ids_sorted = sorted(new_group_set)
        log(f"[PERMISSIONS] source {external_source_id}: added={added}, removed={removed}. Propagating to chunks.")
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE document_vectors
                SET metadata = jsonb_set(metadata, '{group_ids}', %s::jsonb)
                WHERE document_id IN (
                    SELECT id FROM documents WHERE source_id = %s
                )
            """, (json.dumps(new_group_ids_sorted), source_id))
            updated = cur.rowcount
        conn.commit()
        log(f"[PERMISSIONS] Updated group_ids on {updated} chunks for source {external_source_id}.")

    return source_id

def content_hash(*parts) -> str:
    combined = json.dumps(parts, sort_keys=True, default=str)
    return hashlib.sha256(combined.encode()).hexdigest()

def upsert_document_and_vectors(site_id, source_id, document_type, external_document_id,
                                 title, source_url, raw_content, text_content,
                                 source_group_ids, extra_metadata=None) -> tuple:
    group_ids = sorted({g.lower() for g in source_group_ids if g})
    doc_metadata = extra_metadata or {}
    # group_ids intentionally excluded from hash — permission changes must not trigger re-embedding
    h = content_hash(text_content, raw_content, doc_metadata)

    conn = get_conn()

    # Read existing state without starting a write transaction
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, content_hash FROM documents WHERE source_id = %s AND external_document_id = %s",
            (source_id, external_document_id),
        )
        existing = cur.fetchone()

    if existing and existing[1] == h and not FORCE_FULL:
        doc_id = str(existing[0])
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM document_vectors WHERE document_id = %s", (doc_id,))
            vec_count = cur.fetchone()[0]
        if vec_count > 0:
            log(f"Skipping unchanged document {external_document_id}")
            return doc_id, "skipped"

    # Embed all chunks before opening the write transaction so a Bedrock failure
    # leaves the document row untouched rather than in partial state.
    chunks = semantic_chunk_text(text_content)
    embeddings = embed_texts_batch(chunks)

    vector_metadata = {
        "group_ids": group_ids,
        "source_url": source_url,
        "title": title,
        **doc_metadata,
    }

    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO documents (site_id, source_id, document_type, external_document_id,
                    title, source_url, raw_content, text_content, status, content_hash, metadata, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, 'ingested', %s, %s::jsonb, now())
                ON CONFLICT (source_id, external_document_id)
                DO UPDATE SET title = EXCLUDED.title, source_url = EXCLUDED.source_url,
                    raw_content = EXCLUDED.raw_content, text_content = EXCLUDED.text_content,
                    content_hash = EXCLUDED.content_hash, metadata = EXCLUDED.metadata,
                    status = 'ingested',
                    updated_at = now()
                RETURNING id
            """, (site_id, source_id, document_type, external_document_id,
                  title, source_url, json.dumps(raw_content), text_content,
                  h, json.dumps(doc_metadata)))
            doc_id = str(cur.fetchone()[0])

            cur.execute("DELETE FROM document_vectors WHERE document_id = %s", (doc_id,))

            psycopg2.extras.execute_values(cur, """
                INSERT INTO document_vectors (document_id, chunk_index, content, embedding, metadata)
                VALUES %s
            """, [(doc_id, idx, chunk, json.dumps(emb), json.dumps(vector_metadata))
                  for idx, (chunk, emb) in enumerate(zip(chunks, embeddings))],
                template="(%s, %s, %s, %s::vector, %s::jsonb)")

        conn.commit()
    except Exception:
        conn.rollback()
        raise

    log(f"Ingested document {external_document_id} with {len(chunks)} chunks.")
    return doc_id, "ingested"

def delete_document_by_external_id(source_id: str, external_document_id: str):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("DELETE FROM documents WHERE source_id = %s AND external_document_id = %s",
                    (source_id, external_document_id))
    conn.commit()

def clear_source_documents_and_vectors(source_id: str):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("DELETE FROM documents WHERE source_id = %s", (source_id,))
    conn.commit()
    log(f"Cleared all documents for source_id={source_id}")

def refresh_source_counts(source_id: str):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("""
            WITH counts AS (
                SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE status = 'ingested') AS ingested,
                    COUNT(*) FILTER (WHERE status = 'failed') AS failed
                FROM documents WHERE source_id = %s
            )
            UPDATE site_sources SET
                total_documents = counts.total,
                ingested_documents = counts.ingested,
                failed_documents = counts.failed,
                status = CASE
                    WHEN counts.total = 0 THEN 'active'
                    WHEN counts.failed > 0 AND counts.ingested > 0 THEN 'active'
                    WHEN counts.failed > 0 AND counts.ingested = 0 THEN 'active'
                    ELSE 'active'
                END,
                updated_at = now()
            FROM counts WHERE site_sources.id = %s
        """, (source_id, source_id))
    conn.commit()

def refresh_site_status(site_id: str):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE sites SET status = 'active', updated_at = now() WHERE id = %s
        """, (site_id,))
    conn.commit()

def start_ingestion_run(site_id, source_id, run_type, total_documents, triggered_by) -> str:
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("""
            INSERT INTO ingestion_runs (site_id, source_id, run_type, triggered_by, status, started_at, total_documents)
            VALUES (%s, %s, %s, %s, 'running', now(), %s)
            RETURNING id
        """, (site_id, source_id, run_type, triggered_by, total_documents))
        run_id = str(cur.fetchone()[0])
    conn.commit()
    return run_id

def finish_ingestion_run(run_id: str, status: str, error_message: Optional[str] = None):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE ingestion_runs SET status = %s, finished_at = now(), error_message = %s WHERE id = %s
        """, (status, error_message, run_id))
    conn.commit()

def update_site_ingestion_run(run_id: str, site_id: str, status: str,
                               total: int, processed: int, ingested: int,
                               skipped: int, failed: int,
                               error_message: Optional[str] = None):
    """Update the pre-existing site run row created by the trigger Lambda."""
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE ingestion_runs SET
                site_id = %s,
                status = %s,
                finished_at = now(),
                total_documents = %s,
                processed_documents = %s,
                ingested_documents = %s,
                skipped_documents = %s,
                failed_documents = %s,
                error_message = %s
            WHERE id = %s
        """, (site_id, status, total, processed, ingested, skipped, failed, error_message, run_id))
    conn.commit()

def update_run_counts(run_id, processed_delta=0, ingested_delta=0, skipped_delta=0, failed_delta=0):
    conn = get_conn()
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE ingestion_runs SET
                processed_documents = processed_documents + %s,
                ingested_documents = ingested_documents + %s,
                skipped_documents = skipped_documents + %s,
                failed_documents = failed_documents + %s
            WHERE id = %s
        """, (processed_delta, ingested_delta, skipped_delta, failed_delta, run_id))
    conn.commit()

def verify_source_ingestion_success(source_id: str) -> tuple:
    conn = get_conn()
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT
                COUNT(*) FILTER (WHERE d.status = 'failed') AS failed_documents,
                COUNT(*) FILTER (WHERE d.status = 'ingested') AS ingested_documents,
                COUNT(*) FILTER (
                    WHERE d.status = 'ingested'
                    AND NOT EXISTS (SELECT 1 FROM document_vectors v WHERE v.document_id = d.id)
                ) AS ingested_without_vectors
            FROM documents d WHERE d.source_id = %s
        """, (source_id,))
        stats = dict(cur.fetchone())
    success = stats["failed_documents"] == 0 and stats["ingested_without_vectors"] == 0
    return success, stats

# ---------------------------------------------------------------------------
# Embedding — batch up to COHERE_BATCH_SIZE chunks per invoke_model call
# ---------------------------------------------------------------------------
def embed_texts_batch(texts: list, input_type: str = "search_document") -> list:
    results = []
    for i in range(0, len(texts), COHERE_BATCH_SIZE):
        batch = texts[i:i + COHERE_BATCH_SIZE]
        response = bedrock_runtime.invoke_model(
            modelId=EMBEDDING_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps({"texts": batch, "input_type": input_type}),
        )
        results.extend(json.loads(response["body"].read())["embeddings"])
    n_batches = -(-len(texts) // COHERE_BATCH_SIZE) if texts else 0
    log(f"Embedded {len(texts)} chunks in {n_batches} batch(es)")
    return results

# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------
def rough_token_count(text: str) -> int:
    return max(1, int(len(text.split()) * 1.3))

def split_sentences(text: str) -> list:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    return re.split(r"(?<=[.!?])\s+", text)

def semantic_chunk_text(text: str, max_tokens: int = 400, overlap_sentences: int = 1) -> list:
    text = (text or "").strip()
    if not text:
        return []
    if rough_token_count(text) <= max_tokens:
        return [text]
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    units = []
    for p in paragraphs or [text]:
        if rough_token_count(p) <= max_tokens:
            units.append(p)
        else:
            units.extend(split_sentences(p))
    chunks, current = [], []
    for unit in units:
        candidate = " ".join(current + [unit]).strip()
        if current and rough_token_count(candidate) > max_tokens:
            chunks.append(" ".join(current).strip())
            current = current[-overlap_sentences:] if overlap_sentences else []
        current.append(unit)
    if current:
        chunks.append(" ".join(current).strip())
    return [c for c in chunks if c]

# ---------------------------------------------------------------------------
# Narration via Bedrock (Claude Haiku)
# ---------------------------------------------------------------------------
def narrate_fields(fields: dict, list_title: Optional[str] = None) -> str:
    clean_fields = {k: v for k, v in fields.items() if not k.startswith("@") and v}
    llm_payload = {"list_title": list_title, "fields": clean_fields}
    prompt = f"""Convert this SharePoint list item JSON into one natural English paragraph for semantic search.
Rules: Rewrite fields into a coherent, factual sentence preserving field-value meaning. Use list_title as context.
Do not include IDs or system metadata. Output only the paragraph, nothing else.

{json.dumps(llm_payload)}"""
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 512,
        "temperature": 0.0,
        "messages": [{"role": "user", "content": prompt}],
    }
    response = bedrock_llm.invoke_model(
        modelId="us.anthropic.claude-haiku-4-5-20251001-v1:0",
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )
    result = json.loads(response["body"].read())
    return result["content"][0]["text"].strip()

# ---------------------------------------------------------------------------
# Field cleaning
# ---------------------------------------------------------------------------
def clean_item_for_llm(raw_fields: dict, name_map: dict) -> dict:
    clean = {}
    for key, value in raw_fields.items():
        if key in SYSTEM_JUNK:
            continue
        if key.startswith(("@", "_")):
            continue
        if key.endswith("LookupId"):
            continue
        readable_key = name_map.get(key)
        if not readable_key:
            continue
        if value is not None and str(value).strip() != "":
            if isinstance(value, dict):
                value = value.get("LookupValue") or value.get("Email") or str(value)
            clean[readable_key] = value
    return clean

def clean_list_url(raw_url: str) -> str:
    clean_url = raw_url or ""
    if "/Lists/" in clean_url:
        parts = clean_url.split("/")
        try:
            idx = parts.index("Lists")
            clean_url = "/".join(parts[: idx + 2])
        except ValueError:
            pass
    return clean_url

def is_eligible_sharepoint_list(sp_list) -> bool:
    if sp_list.system is not None:
        return False
    if sp_list.list_ and sp_list.list_.hidden:
        return False
    if sp_list.list_ and sp_list.list_.template != "genericList":
        return False
    if sp_list.display_name and sp_list.display_name.startswith("_"):
        return False
    return True

# ---------------------------------------------------------------------------
# Graph / SharePoint REST helpers
# ---------------------------------------------------------------------------
async def resolve_site_url(site_id: str) -> str:
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

async def get_column_mapping(site_id: str, list_id: str) -> dict:
    columns = await graph_client.sites.by_site_id(site_id).lists.by_list_id(list_id).columns.get()
    return {col.name: col.display_name for col in columns.value if col.name and col.display_name}

async def fetch_list_changes(site_id: str, list_id: str, existing_delta_link=None):
    headers = get_graph_headers()
    url = existing_delta_link or f"https://graph.microsoft.com/v1.0/sites/{site_id}/lists/{list_id}/items/delta?expand=fields"
    all_changes, delta_link = [], None
    while url:
        resp = await http_get_with_retry(url, headers)
        data = resp.json()
        all_changes.extend(data.get("value", []))
        url = data.get("@odata.nextLink")
        delta_link = data.get("@odata.deltaLink") or delta_link
    return all_changes, delta_link

# ---------------------------------------------------------------------------
# Group / permission helpers
# ---------------------------------------------------------------------------
async def get_site_backing_group_id(site_id: str) -> Optional[str]:
    try:
        site_url = await resolve_site_url(site_id)
        headers = get_sharepoint_headers(site_url)
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{site_url}/_api/web/allproperties", headers=headers)
            resp.raise_for_status()
            data = resp.json()
        gid = data.get("GroupId") or data.get("groupId")
        return gid.lower() if gid else None
    except Exception as e:
        logger.warning(f"Could not get site backing group: {e}")
        return None

async def expand_sharepoint_group(site_id: str, sp_group_id: int, visited=None) -> set:
    visited = visited or set()
    if sp_group_id in visited:
        return set()
    visited.add(sp_group_id)
    site_url = await resolve_site_url(site_id)
    headers = get_sharepoint_headers(site_url)
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
                        nested = await expand_sharepoint_group(site_id, int(nested_guids[-1]), visited)
                        found.update(nested)
                    except Exception:
                        pass
    except Exception as e:
        logger.warning(f"expand_sharepoint_group failed for group {sp_group_id}: {e}")
    return found

async def list_inherits_permissions(site_id: str, list_id: str) -> bool:
    site_url = await resolve_site_url(site_id)
    headers = get_sharepoint_headers(site_url)
    url = f"{site_url}/_api/web/lists(guid'{list_id}')?$select=HasUniqueRoleAssignments"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    # HasUniqueRoleAssignments=True means the list has broken inheritance (does NOT inherit from site)
    return not data.get("HasUniqueRoleAssignments", False)

async def get_list_authorized_groups(site_id: str, list_id: str) -> list:
    try:
        site_backing_group_id = await get_site_backing_group_id(site_id)
        inherits = await list_inherits_permissions(site_id, list_id)
        headers = get_graph_headers()
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
                    expanded = await expand_sharepoint_group(site_id, int(sp_gid))
                    if site_backing_group_id:
                        expanded.discard(site_backing_group_id)
                    authorized.update(expanded)
        log(f"[AUTH] Resolved {len(authorized)} authorized groups for list {list_id}")
        return list(authorized)
    except Exception as e:
        logger.error(f"[AUTH] get_list_authorized_groups failed: {e}", exc_info=True)
        return []

async def upsert_entra_groups(group_ids: list) -> None:
    """Fetch display names for group_ids from Graph and upsert into entra_groups.
    Glue is the sole writer of this table — sign-up never touches it."""
    if not group_ids:
        return
    headers = get_graph_headers()
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
        conn = get_conn()
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
        log(f"[AUTH] Upserted {len(rows)} groups into entra_groups")
    except Exception as e:
        logger.error(f"[AUTH] upsert_entra_groups DB write failed: {e}")

# ---------------------------------------------------------------------------
# Core ingestion
# ---------------------------------------------------------------------------
async def run_sharepoint_list_ingestion(site_row_id, external_site_id, sp_list, triggered_by="manual", force_full=False) -> dict:
    if not is_eligible_sharepoint_list(sp_list):
        log(f"Skipping ineligible list: {sp_list.display_name}")
        return {"source_id": None, "status": "skipped", "list_id": sp_list.id, "list_name": sp_list.display_name}

    log(f"--- Processing list: {sp_list.display_name} ---")

    auth_groups = await get_list_authorized_groups(external_site_id, sp_list.id)
    await upsert_entra_groups(auth_groups)

    source_row_id = upsert_site_source(
        site_id=site_row_id,
        source_type="list",
        external_source_id=sp_list.id,
        name=sp_list.display_name,
        source_url=None,
        total_documents=0,
        group_ids=auth_groups,
    )

    if force_full:
        log(f"force_full=True — clearing existing documents for {sp_list.display_name}")
        clear_source_documents_and_vectors(source_row_id)

    existing_cursor = None if force_full else get_source_cursor(source_row_id)
    name_map = await get_column_mapping(external_site_id, sp_list.id)
    changes, proposed_delta_link = await fetch_list_changes(external_site_id, sp_list.id, existing_delta_link=existing_cursor)

    source_run_id = start_ingestion_run(
        site_id=site_row_id,
        source_id=source_row_id,
        run_type="source",
        total_documents=len(changes or []),
        triggered_by=triggered_by,
    )

    if not changes:
        log(f"No changes for {sp_list.display_name}.")
        if proposed_delta_link:
            save_source_cursor(source_row_id, proposed_delta_link)
        refresh_source_counts(source_row_id)
        finish_ingestion_run(source_run_id, "completed")
        return {"source_id": source_row_id, "run_id": source_run_id, "status": "completed", "processed": 0, "failed": 0, "skipped": 0, "list_id": sp_list.id, "list_name": sp_list.display_name}

    total_items = len(changes)
    log(f"Processing {total_items} items in '{sp_list.display_name}'")
    source_success = True
    failed_count = 0
    processed_count = 0
    skipped_count = 0

    for item in changes:
        item_id = item.get("id")
        try:
            is_deleted = "deleted" in item or "@removed" in item
            if is_deleted:
                delete_document_by_external_id(source_row_id, item_id)
                update_run_counts(source_run_id, processed_delta=1, ingested_delta=1)
                processed_count += 1
                continue

            clean_fields = clean_item_for_llm(item.get("fields", {}), name_map)
            narrative = narrate_fields(clean_fields, list_title=sp_list.display_name)
            if not narrative:
                raise ValueError(f"Empty narration for item {item_id}")

            raw_url = item.get("webUrl", "")
            clean_url = clean_list_url(raw_url)
            structured_id = hashlib.sha256(f"{external_site_id}_{sp_list.id}_{item_id}".encode()).hexdigest()
            extra_metadata = {
                "structured_id": structured_id,
                "sharepoint_site_id": external_site_id,
                "sharepoint_list_id": sp_list.id,
                "sharepoint_list_title": sp_list.display_name,
                "sharepoint_item_id": item_id,
            }

            _, status = upsert_document_and_vectors(
                site_id=site_row_id,
                source_id=source_row_id,
                document_type="list_item",
                external_document_id=item_id,
                title=clean_fields.get("Title") or clean_fields.get("title") or sp_list.display_name,
                source_url=clean_url,
                raw_content=clean_fields,
                text_content=narrative,
                source_group_ids=auth_groups,
                extra_metadata=extra_metadata,
            )

            if status == "skipped":
                skipped_count += 1
                update_run_counts(source_run_id, processed_delta=1, skipped_delta=1)
            else:
                update_run_counts(source_run_id, processed_delta=1, ingested_delta=1)
            processed_count += 1
            log(f"[{processed_count}/{total_items}] '{sp_list.display_name}' — item {item_id} {status}")

        except Exception as e:
            logger.error(f"Failed item {item_id}: {e}", exc_info=True)
            source_success = False
            failed_count += 1
            processed_count += 1
            update_run_counts(source_run_id, processed_delta=1, failed_delta=1)
            log(f"[{processed_count}/{total_items}] '{sp_list.display_name}' — item {item_id} FAILED")

    verified_success, verification_stats = verify_source_ingestion_success(source_row_id)
    final_status = "completed" if (source_success and verified_success) else "partial"

    if final_status == "completed" and proposed_delta_link:
        save_source_cursor(source_row_id, proposed_delta_link)

    refresh_source_counts(source_row_id)
    finish_ingestion_run(source_run_id, final_status, error_message=None if final_status == "completed" else json.dumps(verification_stats))

    log(f"Finished {sp_list.display_name}: status={final_status}, processed={processed_count}, failed={failed_count}, skipped={skipped_count}")
    return {"source_id": source_row_id, "run_id": source_run_id, "status": final_status, "processed": processed_count, "failed": failed_count, "skipped": skipped_count, "list_id": sp_list.id, "list_name": sp_list.display_name}


async def run_site_ingestion(site_id, triggered_by="manual", force_full=False) -> str:
    site_url = await resolve_site_url(site_id)
    site_row_id = upsert_site(external_site_id=site_id, name="SharePoint Site", site_url=site_url)

    log("Discovering lists...")
    lists = await graph_client.sites.by_site_id(site_id).lists.get()
    eligible = [l for l in lists.value if is_eligible_sharepoint_list(l)]
    log(f"Found {len(eligible)} eligible lists.")

    any_failed = False
    completed = failed = 0
    total_processed = total_ingested = total_skipped = total_failed = 0

    for sp_list in eligible:
        try:
            result = await run_sharepoint_list_ingestion(
                site_row_id=site_row_id,
                external_site_id=site_id,
                sp_list=sp_list,
                triggered_by=triggered_by,
                force_full=force_full,
            )
            total_processed += result.get("processed", 0)
            total_skipped += result.get("skipped", 0)
            total_failed += result.get("failed", 0)
            total_ingested += result.get("processed", 0) - result.get("failed", 0) - result.get("skipped", 0)
            if result["status"] in ("completed", "partial"):
                completed += 1
                if result.get("failed", 0) > 0:
                    any_failed = True
            else:
                failed += 1
                any_failed = True
        except Exception as e:
            logger.error(f"Failed list {sp_list.display_name}: {e}", exc_info=True)
            any_failed = True
            failed += 1

    refresh_site_status(site_row_id)
    final_status = "failed" if (failed == len(eligible) and len(eligible) > 0) else "completed"
    error_msg = None if not any_failed else json.dumps({"lists_completed": completed, "lists_failed": failed})

    if INGESTION_RUN_ID:
        update_site_ingestion_run(
            run_id=INGESTION_RUN_ID,
            site_id=site_row_id,
            status=final_status,
            total=len(eligible),
            processed=total_processed,
            ingested=total_ingested,
            skipped=total_skipped,
            failed=total_failed,
            error_message=error_msg,
        )

    log(f"Site ingestion done: status={final_status}, completed={completed}, failed={failed}")
    return site_row_id


# ---------------------------------------------------------------------------
# Entrypoint — all side-effectful init happens here, not at module level
# ---------------------------------------------------------------------------
def main():
    global secrets_client, bedrock_runtime, bedrock_llm
    global credential, rest_credential, graph_client, SITE_ID

    _BEDROCK_CONFIG = Config(connect_timeout=10, read_timeout=60, retries={"max_attempts": 2})
    secrets_client = boto3.client("secretsmanager", region_name=REGION)
    bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION, config=_BEDROCK_CONFIG)
    bedrock_llm = boto3.client("bedrock-runtime", region_name=LLM_REGION, config=_BEDROCK_CONFIG)

    sp_creds = json.loads(get_secret(SHAREPOINT_SECRET_NAME))
    SITE_ID = sp_creds["site_id"]
    tenant_id = sp_creds["tenant_id"]
    client_id = sp_creds["client_id"]
    client_secret = sp_creds["client_secret"]

    pfx_b64 = get_secret(SHAREPOINT_CERT_SECRET)
    pfx_password = get_secret(SHAREPOINT_CERT_PASSWORD_SECRET)
    pfx_bytes = base64.b64decode(pfx_b64)

    credential = ClientSecretCredential(tenant_id, client_id, client_secret)
    rest_credential = CertificateCredential(
        tenant_id=tenant_id,
        client_id=client_id,
        certificate_data=pfx_bytes,
        password=pfx_password,
    )
    graph_client = GraphServiceClient(credential)
    log("Credentials and clients initialized.")

    try:
        get_conn()
        log(f"DB connection OK — host={RDS_PROXY_ENDPOINT}")
    except Exception as e:
        logger.error(f"DB connection FAILED — host={RDS_PROXY_ENDPOINT}: {e}", exc_info=True)
        raise

    asyncio.run(run_site_ingestion(
        site_id=SITE_ID,
        triggered_by=TRIGGERED_BY,
        force_full=FORCE_FULL,
    ))
    log("Ingestion job complete.")


if __name__ == "__main__":
    main()
