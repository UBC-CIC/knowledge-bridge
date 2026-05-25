import os
import json
import logging
import boto3

from helpers.cors import get_cors_headers

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]

s3_client = boto3.client("s3", region_name=REGION)


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
    """Look up the internal user ID for the admin email provided by the request"""
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


def _is_markdown_file(file_name: str) -> bool:
    lower_name = file_name.lower()
    return lower_name.endswith(".md") or lower_name.endswith(".markdown")


def _validate_file_pair(source_type: str, file_name: str, metadata_file_name: str) -> str | None:
    if source_type == "csv":
        if not file_name.endswith(".csv"):
            return "csv_file_name must end with .csv"
    elif source_type == "markdown":
        if not _is_markdown_file(file_name):
            return "markdown_file_name must end with .md or .markdown"
    else:
        return "Unsupported file source type"

    if not metadata_file_name.endswith(".json"):
        return "metadata_file_name must end with .json"

    expected_metadata_name = f"{file_name}.metadata.json"
    if metadata_file_name != expected_metadata_name:
        return (
            "metadata_file_name must exactly match the primary file base name as "
            f"'{expected_metadata_name}'"
        )

    return None


def _assert_s3_object_exists(bucket: str, key: str):
    """Verify that an uploaded file already exists in S3 before staging it"""
    s3_client.head_object(Bucket=bucket, Key=key)


def _existing_website_row_id(connection, *, name: str) -> str | None:
    """Check whether a website data source with the same URL already exists"""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM data_sources
            WHERE type = %s::data_source_type
              AND name = %s
            LIMIT 1
            """,
            ("website", name),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def _existing_file_row_id(connection, *, s3_bucket: str, s3_key: str) -> str | None:
    """Check whether a staged file already exists by matching its S3 bucket and key"""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM data_sources
            WHERE metadata->>'s3_bucket' = %s
              AND metadata->>'s3_key' = %s
            LIMIT 1
            """,
            (s3_bucket, s3_key),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def _insert_data_source_row(
    connection,
    *,
    name: str,
    data_source_type: str,
    created_by_user_id: str,
    metadata: dict,
    include_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
) -> str:
    """
    Insert a new row into data_sources
    This stores the staged source itself, but does not start ingestion
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO data_sources (
                name,
                type,
                include_patterns,
                exclude_patterns,
                created_by,
                metadata
            )
            VALUES (%s, %s::data_source_type, %s, %s, %s::uuid, %s::jsonb)
            RETURNING id
            """,
            (
                name,
                data_source_type,
                include_patterns,
                exclude_patterns,
                created_by_user_id,
                json.dumps(metadata),
            ),
        )
        row = cursor.fetchone()
        return str(row[0])


def _insert_ingestion_run_row(
    connection,
    *,
    data_source_row_id: str,
    status: str,
    metadata: dict | None = None,
) -> str:
    """
    Insert an initial ingestion_runs row for a staged source
    New staged sources start in 'pending' so they can later be promoted to
    'queued' when the admin clicks Sync
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ingestion_runs (
                data_source_id,
                status,
                error_message,
                metadata
            )
            VALUES (%s::uuid, %s::ingestion_status, NULL, %s::jsonb)
            RETURNING id
            """,
            (
                data_source_row_id,
                status,
                json.dumps(metadata or {}),
            ),
        )
        row = cursor.fetchone()
        return str(row[0])


def stage_data_sources(event, body, connection):
    """
    Stage either a website, CSV/JSON pair, or markdown/JSON pair for future syncing

    This method:
    - validates the request
    - inserts the appropriate data_sources row(s)
    - creates matching ingestion_runs row(s) with status 'pending'
    - does NOT start ingestion or create schedulers

    Supported request types:
    - type = "website"
    - type = "csv"
    - type = "markdown"
    """
    source_type = body.get("type")
    created_by = body.get("created_by")

    if source_type not in {"website", "csv", "markdown"}:
        return _response(event, 400, {"error": "type must be one of: website, csv, markdown"})

    if not created_by:
        return _response(event, 400, {"error": "Missing created_by"})

    created_by_user_id = _get_user_id_by_email(connection, created_by)
    if not created_by_user_id:
        return _response(event, 400, {"error": "Admin user not found in database"})

    try:
        if source_type == "website":
            name = body.get("name")
            include_patterns = body.get("include_patterns", [])
            exclude_patterns = body.get("exclude_patterns", [])

            if not name:
                return _response(event, 400, {"error": "Missing name of the website"})

            if not isinstance(include_patterns, list):
                return _response(event, 400, {"error": "include_patterns must be an array"})

            if not isinstance(exclude_patterns, list):
                return _response(event, 400, {"error": "exclude_patterns must be an array"})

            existing_id = _existing_website_row_id(connection, name=name)
            if existing_id:
                return _response(
                    event,
                    409,
                    {
                        "error": "Website already exists in data_sources",
                        "existing_data_source_id": existing_id,
                        "name": name,
                    },
                )

            data_source_metadata = {
                "source": "staged_website",
                "action": "staged_for_future_sync",
            }

            data_source_id = _insert_data_source_row(
                connection,
                name=name,
                data_source_type="website",
                created_by_user_id=created_by_user_id,
                metadata=data_source_metadata,
                include_patterns=include_patterns if include_patterns else None,
                exclude_patterns=exclude_patterns if exclude_patterns else None,
            )

            ingestion_run_id = _insert_ingestion_run_row(
                connection,
                data_source_row_id=data_source_id,
                status="pending",
                metadata={
                    "source": "staged_website",
                    "action": "awaiting_sync",
                },
            )

            connection.commit()

            return _response(
                event,
                200,
                {
                    "message": "Website staged successfully.",
                    "action": "staged_website",
                    "type": "website",
                    "created_by": created_by,
                    "staged_data_source_ids": [data_source_id],
                    "pending_ingestion_run_ids": [ingestion_run_id],
                },
            )

        if source_type == "csv":
            primary_file_name = body.get("csv_file_name")
            primary_s3_bucket = body.get("csv_s3_bucket")
            primary_s3_key = body.get("csv_s3_key")
            primary_data_source_type = "csv"
            primary_source_label = "csv"
        else:
            primary_file_name = body.get("markdown_file_name")
            primary_s3_bucket = body.get("markdown_s3_bucket")
            primary_s3_key = body.get("markdown_s3_key")
            primary_data_source_type = "markdown"
            primary_source_label = "markdown"

        metadata_file_name = body.get("metadata_file_name")
        metadata_s3_bucket = body.get("metadata_s3_bucket")
        metadata_s3_key = body.get("metadata_s3_key")

        if not primary_file_name or not primary_s3_bucket or not primary_s3_key:
            return _response(event, 400, {"error": f"Missing {primary_source_label} file details"})

        if not metadata_file_name or not metadata_s3_bucket or not metadata_s3_key:
            return _response(event, 400, {"error": "Missing metadata JSON file details"})

        pair_error = _validate_file_pair(source_type, primary_file_name, metadata_file_name)
        if pair_error:
            return _response(event, 400, {"error": pair_error})

        try:
            _assert_s3_object_exists(primary_s3_bucket, primary_s3_key)
            _assert_s3_object_exists(metadata_s3_bucket, metadata_s3_key)
        except Exception as e:
            logger.error("Uploaded file not found in S3: %s", e, exc_info=True)
            return _response(event, 400, {"error": "One or both uploaded files do not exist in S3"})

        existing_primary_id = _existing_file_row_id(
            connection, s3_bucket=primary_s3_bucket, s3_key=primary_s3_key
        )
        if existing_primary_id:
            return _response(
                event,
                409,
                {
                    "error": f"{primary_source_label.capitalize()} file already exists in data_sources",
                    "existing_data_source_id": existing_primary_id,
                    "file_name": primary_file_name,
                },
            )

        existing_json_id = _existing_file_row_id(
            connection, s3_bucket=metadata_s3_bucket, s3_key=metadata_s3_key
        )
        if existing_json_id:
            return _response(
                event,
                409,
                {
                    "error": "Metadata JSON file already exists in data_sources",
                    "existing_data_source_id": existing_json_id,
                    "metadata_file_name": metadata_file_name,
                },
            )

        primary_data_source_metadata = {
            "source": "staged_s3_file",
            "action": "staged_for_future_sync",
            "s3_bucket": primary_s3_bucket,
            "s3_key": primary_s3_key,
            "companion_file_name": metadata_file_name,
            "companion_s3_bucket": metadata_s3_bucket,
            "companion_s3_key": metadata_s3_key,
        }

        json_data_source_metadata = {
            "source": "staged_s3_file",
            "action": "staged_for_future_sync",
            "s3_bucket": metadata_s3_bucket,
            "s3_key": metadata_s3_key,
            "companion_file_name": primary_file_name,
            "companion_s3_bucket": primary_s3_bucket,
            "companion_s3_key": primary_s3_key,
        }

        primary_data_source_id = _insert_data_source_row(
            connection,
            name=primary_file_name,
            data_source_type=primary_data_source_type,
            created_by_user_id=created_by_user_id,
            metadata=primary_data_source_metadata,
        )

        json_data_source_id = _insert_data_source_row(
            connection,
            name=metadata_file_name,
            data_source_type="json",
            created_by_user_id=created_by_user_id,
            metadata=json_data_source_metadata,
        )

        primary_ingestion_run_id = _insert_ingestion_run_row(
            connection,
            data_source_row_id=primary_data_source_id,
            status="pending",
            metadata={
                "source": f"staged_{primary_source_label}_file",
                "action": "awaiting_sync",
                "s3_bucket": primary_s3_bucket,
                "s3_key": primary_s3_key,
            },
        )

        json_ingestion_run_id = _insert_ingestion_run_row(
            connection,
            data_source_row_id=json_data_source_id,
            status="pending",
            metadata={
                "source": "staged_json_file",
                "action": "awaiting_sync",
                "s3_bucket": metadata_s3_bucket,
                "s3_key": metadata_s3_key,
            },
        )

        connection.commit()

        return _response(
            event,
            200,
            {
                "message": f"{primary_source_label.capitalize()} and metadata JSON staged successfully.",
                "action": f"staged_{primary_source_label}_and_metadata",
                "type": source_type,
                "created_by": created_by,
                "staged_data_source_ids": [primary_data_source_id, json_data_source_id],
                "pending_ingestion_run_ids": [primary_ingestion_run_id, json_ingestion_run_id],
            },
        )

    except Exception as e:
        connection.rollback()
        logger.error("Failed to stage data sources: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to stage data sources"})