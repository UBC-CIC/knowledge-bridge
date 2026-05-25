import os
import json
from helpers.cors import get_cors_headers
import logging
import boto3
from uuid import uuid4

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]
SCHEDULER_ROLE_ARN = os.environ["SCHEDULER_ROLE_ARN"]
SCHEDULER_TARGET_ARN = os.environ["SCHEDULER_TARGET_ARN"]

bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
scheduler_client = boto3.client("scheduler", region_name=REGION)


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


def _list_all_data_sources(knowledge_base_id: str) -> list[dict]:
    """
    Fetch every Bedrock data source attached to the knowledge base.
    Pagination is handled so the caller always receives the full list.
    """
    items = []
    next_token = None

    while True:
        kwargs = {
            "knowledgeBaseId": knowledge_base_id,
            "maxResults": 100,
        }
        if next_token:
            kwargs["nextToken"] = next_token

        resp = bedrock_agent.list_data_sources(**kwargs)
        items.extend(resp.get("dataSourceSummaries", []))
        next_token = resp.get("nextToken")

        if not next_token:
            break

    return items


def _get_data_source(knowledge_base_id: str, data_source_id: str) -> dict:
    """Fetch the full Bedrock configuration for a specific data source"""
    resp = bedrock_agent.get_data_source(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=data_source_id,
    )
    return resp["dataSource"]


def _is_s3_data_source(data_source: dict) -> bool:
    """Return True when the Bedrock data source is configured as S3"""
    return data_source.get("dataSourceConfiguration", {}).get("type") == "S3"


def _latest_run_rows_by_status(connection, *, status: str, data_source_types: list[str]) -> list[dict]:
    """
    Return the latest ingestion run per data source filtered by status and type.

    For the S3 phase, this is used to collect the currently queued CSV/markdown and JSON
    sources that should be included in the next ingestion run.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH latest_runs AS (
                SELECT
                    ir.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY ir.data_source_id
                        ORDER BY ir.created_at DESC, ir.id DESC
                    ) AS rn
                FROM ingestion_runs ir
            )
            SELECT
                lr.id,
                lr.data_source_id,
                lr.status,
                lr.metadata,
                ds.name,
                ds.type,
                ds.metadata
            FROM latest_runs lr
            JOIN data_sources ds ON ds.id = lr.data_source_id
            WHERE lr.rn = 1
              AND lr.status = %s::ingestion_status
              AND ds.type = ANY(%s::data_source_type[])
            ORDER BY ds.created_at ASC, ds.id ASC
            """,
            (status, data_source_types),
        )

        rows = cursor.fetchall()
        results = []
        for row in rows:
            results.append(
                {
                    "ingestion_run_id": str(row[0]),
                    "data_source_id": str(row[1]),
                    "status": row[2],
                    "ingestion_metadata": row[3] or {},
                    "name": row[4],
                    "type": row[5],
                    "data_source_metadata": row[6] or {},
                }
            )
        return results


def _get_single_s3_data_source(knowledge_base_id: str) -> dict | None:
    """
    Locate the single shared S3 Bedrock data source for the knowledge base.
    The S3 ingestion model assumes exactly one S3 data source is available.
    """
    all_data_sources = _list_all_data_sources(knowledge_base_id)

    s3_data_sources = []
    for summary in all_data_sources:
        data_source = _get_data_source(knowledge_base_id, summary["dataSourceId"])
        if _is_s3_data_source(data_source):
            s3_data_sources.append(data_source)

    if len(s3_data_sources) != 1:
        return None

    return s3_data_sources[0]


def _start_ingestion(knowledge_base_id: str, data_source_id: str) -> dict:
    """
    Start a Bedrock ingestion job for the shared S3 data source.

    This kicks off ingestion for all queued CSV/markdown and JSON sources staged for
    the current sync session.
    """
    resp = bedrock_agent.start_ingestion_job(
        knowledgeBaseId=knowledge_base_id,
        dataSourceId=data_source_id,
        description="Triggered by queued S3 batch sync",
    )
    return resp["ingestionJob"]


def _create_ingestion_polling_schedule(
    *,
    knowledge_base_id: str,
    bedrock_data_source_id: str,
    bedrock_ingestion_job_id: str,
    db_ingestion_run_ids: list[str],
    sync_session_id: str,
) -> str:
    """
    Create the 5-minute scheduler that polls the S3 ingestion job.

    The scheduler payload carries the sync session ID and the database run IDs
    so update_status can later update all affected ingestion runs together.
    """
    schedule_name = f"kb-s3-{sync_session_id}-{uuid4().hex[:8]}"

    payload = {
        "task": "poll_ingestion_run",
        "phase": "s3",
        "knowledge_base_id": knowledge_base_id,
        "bedrock_data_source_id": bedrock_data_source_id,
        "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
        "db_ingestion_run_ids": db_ingestion_run_ids,
        "sync_session_id": sync_session_id,
        "schedule_name": schedule_name,
    }

    scheduler_client.create_schedule(
        Name=schedule_name,
        GroupName="default",
        ScheduleExpression="rate(5 minutes)",
        FlexibleTimeWindow={"Mode": "OFF"},
        State="ENABLED",
        Target={
            "Arn": SCHEDULER_TARGET_ARN,
            "RoleArn": SCHEDULER_ROLE_ARN,
            "Input": json.dumps(payload),
        },
        Description=f"Poll S3 ingestion job {bedrock_ingestion_job_id} for sync session {sync_session_id}",
    )

    return schedule_name


def _mark_runs_running(
    connection,
    *,
    ingestion_run_ids: list[str],
    bedrock_ingestion_job_id: str,
    sync_session_id: str,
    schedule_name: str,
):
    """
    Mark the selected CSV/markdown and JSON ingestion runs as running.

    The metadata is updated with the current sync session, Bedrock ingestion
    job ID, scheduler name, and phase so later polling can resume correctly.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET
                status = 'running'::ingestion_status,
                metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = ANY(%s::uuid[])
            """,
            (
                json.dumps(
                    {
                        "phase": "s3",
                        "sync_session_id": sync_session_id,
                        "bedrock_ingestion_job_id": bedrock_ingestion_job_id,
                        "schedule_name": schedule_name,
                    }
                ),
                ingestion_run_ids,
            ),
        )


def process_s3_batch(event, connection, kb_id, sync_session_id: str, triggered_by_scheduler: bool = False):
    """
    Start the S3 phase for the current sync session.

    This method:
    - finds the latest queued CSV/markdown and JSON ingestion runs
    - locates the shared S3 Bedrock data source
    - starts one Bedrock ingestion job for that shared data source
    - creates the 5-minute polling scheduler
    - marks all selected database runs as running

    It returns a structured result describing whether the phase started and
    which run IDs were attached to it.
    """
    queued_runs = _latest_run_rows_by_status(
        connection,
        status="queued",
        data_source_types=["csv", "markdown", "json"],
    )

    if not queued_runs:
        return {
            "started": False,
            "phase": "s3",
            "message": "No queued S3 runs found.",
        }

    s3_data_source = _get_single_s3_data_source(kb_id)
    if not s3_data_source:
        return {
            "started": False,
            "phase": "s3",
            "error": "Expected exactly one S3 data source in the knowledge base.",
        }

    ingestion_job = _start_ingestion(kb_id, s3_data_source["dataSourceId"])
    ingestion_run_ids = [x["ingestion_run_id"] for x in queued_runs]

    schedule_name = _create_ingestion_polling_schedule(
        knowledge_base_id=kb_id,
        bedrock_data_source_id=s3_data_source["dataSourceId"],
        bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
        db_ingestion_run_ids=ingestion_run_ids,
        sync_session_id=sync_session_id,
    )

    _mark_runs_running(
        connection,
        ingestion_run_ids=ingestion_run_ids,
        bedrock_ingestion_job_id=ingestion_job["ingestionJobId"],
        sync_session_id=sync_session_id,
        schedule_name=schedule_name,
    )
    connection.commit()

    return {
        "started": True,
        "phase": "s3",
        "triggered_by_scheduler": triggered_by_scheduler,
        "sync_session_id": sync_session_id,
        "queued_count": len(queued_runs),
        "bedrock_data_source_id": s3_data_source["dataSourceId"],
        "bedrock_data_source_name": s3_data_source["name"],
        "bedrock_ingestion_job_id": ingestion_job["ingestionJobId"],
        "schedule_name": schedule_name,
        "db_ingestion_run_ids": ingestion_run_ids,
    }