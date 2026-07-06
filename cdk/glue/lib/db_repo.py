"""
PostgreSQL repository for the SharePoint ingestion pipeline.

Manages a single reused psycopg2 connection (job-scoped singleton) and provides
all DB read/write operations: sites, sources, documents, vectors, ingestion runs,
and access control tables.

Call init_db() once at job startup before invoking any other function.
"""

import json
import hashlib
import logging
from typing import Optional, Callable

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)

_RDS_PROXY_ENDPOINT: Optional[str] = None
_DB_SECRET: Optional[dict] = None
_conn = None


def init_db(rds_proxy_endpoint: str, db_secret_dict: dict) -> None:
    global _RDS_PROXY_ENDPOINT, _DB_SECRET
    _RDS_PROXY_ENDPOINT = rds_proxy_endpoint
    _DB_SECRET = db_secret_dict


def _make_db_conn():
    return psycopg2.connect(
        host=_RDS_PROXY_ENDPOINT,
        port=_DB_SECRET.get("port", 5432),
        dbname=_DB_SECRET.get("dbname", "kba"),
        user=_DB_SECRET["username"],
        password=_DB_SECRET["password"],
        sslmode="require",
    )


def get_conn():
    global _conn
    if _conn is None or _conn.closed:
        _conn = _make_db_conn()
    else:
        try:
            _conn.cursor().execute("SELECT 1")
        except Exception:
            _conn = _make_db_conn()
    return _conn


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
# Site / source / document helpers
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

        cur.execute("SELECT entra_group_id FROM site_source_access WHERE site_source_id = %s", (source_id,))
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

    if added or removed:
        new_group_ids_sorted = sorted(new_group_set)
        logger.info("[PERMISSIONS] source %s: added=%s, removed=%s. Propagating to chunks.", external_source_id, added, removed)
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE document_vectors
                SET metadata = jsonb_set(metadata, '{group_ids}', %s::jsonb)
                WHERE document_id IN (SELECT id FROM documents WHERE source_id = %s)
            """, (json.dumps(new_group_ids_sorted), source_id))
            updated = cur.rowcount
        conn.commit()
        logger.info("[PERMISSIONS] Updated group_ids on %d chunks for source %s.", updated, external_source_id)

    return source_id


def content_hash(*parts) -> str:
    combined = json.dumps(parts, sort_keys=True, default=str)
    return hashlib.sha256(combined.encode()).hexdigest()


def upsert_document_and_vectors(
    site_id, source_id, document_type, external_document_id,
    title, source_url, raw_content, text_content,
    source_group_ids,
    chunk_fn: Callable,
    embed_fn: Callable,
    extra_metadata=None,
    force_full: bool = False,
) -> tuple:
    group_ids = sorted({g.lower() for g in source_group_ids if g})
    doc_metadata = extra_metadata or {}
    # group_ids intentionally excluded from hash — permission changes must not trigger re-embedding
    h = content_hash(text_content, raw_content, doc_metadata)

    conn = get_conn()

    # Transaction 1: upsert document row and read the stored hash atomically
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
            RETURNING id, content_hash
        """, (site_id, source_id, document_type, external_document_id,
              title, source_url, json.dumps(raw_content), text_content,
              h, json.dumps(doc_metadata)))
        row = cur.fetchone()
        doc_id = str(row[0])
        stored_hash = row[1]

        if stored_hash == h and not force_full:
            cur.execute("SELECT COUNT(*) FROM document_vectors WHERE document_id = %s", (doc_id,))
            vec_count = cur.fetchone()[0]
        else:
            vec_count = 0

    conn.commit()

    if stored_hash == h and not force_full and vec_count > 0:
        logger.info("Skipping unchanged document %s", external_document_id)
        return doc_id, "skipped"

    # Compute chunks and embeddings outside any transaction (external API calls)
    chunks = chunk_fn(text_content)
    vector_metadata = {
        "group_ids": group_ids,
        "source_url": source_url,
        "title": title,
        **doc_metadata,
    }
    embeddings = embed_fn(chunks)

    # Transaction 2: replace vectors atomically — delete old then insert new
    with conn.cursor() as cur:
        cur.execute("DELETE FROM document_vectors WHERE document_id = %s", (doc_id,))
        for idx, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
            cur.execute("""
                INSERT INTO document_vectors (document_id, chunk_index, content, embedding, metadata)
                VALUES (%s, %s, %s, %s::vector, %s::jsonb)
            """, (doc_id, idx, chunk, json.dumps(embedding), json.dumps(vector_metadata)))
    conn.commit()

    logger.info("Ingested document %s with %d chunks.", external_document_id, len(chunks))
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
    logger.info("Cleared all documents for source_id=%s", source_id)


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
        cur.execute("UPDATE sites SET status = 'active', updated_at = now() WHERE id = %s", (site_id,))
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
