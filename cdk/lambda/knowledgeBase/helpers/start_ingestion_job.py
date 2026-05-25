import os
import json
import logging
from uuid import uuid4

from helpers.cors import get_cors_headers
from helpers.process_s3_batch import process_s3_batch
from helpers.process_website_batch import process_website_batch

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]


def _response(event, status_code: int, body: dict):
    """Build a standard API Gateway JSON response with CORS headers"""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }


def _get_user_id_by_email(connection, email: str) -> str | None:
    """Look up the internal user ID for the admin email that initiated the sync"""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM users
            WHERE email = %s
            LIMIT 1
            """,
            (email,),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def _promote_pending_to_queued(connection, *, sync_session_id: str) -> int:
    """
    Promote the latest pending ingestion run for each data source to queued.
    This is the first step of a sync session. It marks staged work as officially
    selected for ingestion and stamps the runs with the sync_session_id so the
    rest of the workflow can track them as part of the same sync.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH latest_runs AS (
                SELECT
                    ir.id,
                    ir.data_source_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY ir.data_source_id
                        ORDER BY ir.created_at DESC, ir.id DESC
                    ) AS rn
                FROM ingestion_runs ir
            )
            UPDATE ingestion_runs ir
            SET
                status = 'queued'::ingestion_status,
                metadata = COALESCE(ir.metadata, '{}'::jsonb) || %s::jsonb
            FROM latest_runs lr
            WHERE ir.id = lr.id
              AND lr.rn = 1
              AND ir.status = 'pending'::ingestion_status
            """,
            (json.dumps({"sync_session_id": sync_session_id}),),
        )
        return cursor.rowcount


def start_ingestion_job(event, body, connection, kb_id):
    """
    Start a new sync session for staged data sources.

    This method:
    - validates the requesting admin
    - creates a new sync_session_id
    - promotes pending ingestion runs to queued
    - attempts to start the S3 batch first
    - if no S3 batch is eligible, attempts to start the website batch
    - returns the first phase that was successfully started

    The actual ingestion work is delegated to:
    - process_s3_batch(...)
    - process_website_batch(...)
    """
    created_by = body.get("created_by")
    if not created_by:
        return _response(event, 400, {"error": "Missing created_by"})

    created_by_user_id = _get_user_id_by_email(connection, created_by)
    if not created_by_user_id:
        return _response(event, 400, {"error": "Admin user not found in database"})

    sync_session_id = uuid4().hex

    try:
        queued_count = _promote_pending_to_queued(
            connection,
            sync_session_id=sync_session_id,
        )
        connection.commit()

        if queued_count == 0:
            return _response(
                event,
                409,
                {
                    "error": "No pending data sources found to queue.",
                    "sync_session_id": sync_session_id,
                },
            )

        s3_started = process_s3_batch(
            event=event,
            connection=connection,
            kb_id=kb_id,
            sync_session_id=sync_session_id,
            triggered_by_scheduler=False,
        )
        if s3_started.get("started"):
            return _response(
                event,
                200,
                {
                    "message": "Pending data sources queued and S3 sync started.",
                    "action": "queued_and_started_s3_sync",
                    "sync_session_id": sync_session_id,
                    "queued_count": queued_count,
                    "phase_started": "s3",
                    "details": s3_started,
                },
            )

        website_started = process_website_batch(
            event=event,
            connection=connection,
            kb_id=kb_id,
            sync_session_id=sync_session_id,
            triggered_by_scheduler=False,
        )
        if website_started.get("started"):
            return _response(
                event,
                200,
                {
                    "message": "Pending data sources queued and website sync started.",
                    "action": "queued_and_started_website_sync",
                    "sync_session_id": sync_session_id,
                    "queued_count": queued_count,
                    "phase_started": "website",
                    "details": website_started,
                },
            )

        return _response(
            event,
            409,
            {
                "error": "Pending data sources were queued, but no eligible batch could be started.",
                "sync_session_id": sync_session_id,
                "queued_count": queued_count,
                "s3_result": s3_started,
                "website_result": website_started,
            },
        )

    except Exception as e:
        connection.rollback()
        logger.error("Failed to start ingestion job orchestration: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to start ingestion job orchestration"})