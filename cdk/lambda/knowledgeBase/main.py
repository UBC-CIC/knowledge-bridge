import os
import json
from helpers.cors import get_cors_headers
import boto3
import logging
import psycopg2

from helpers.stage_data_sources import stage_data_sources
from helpers.stage_data_sources_batch import stage_data_sources_batch
from helpers.start_ingestion_job import start_ingestion_job
from helpers.generate_presigned_url import generate_presigned_url
from helpers.generate_presigned_urls_batch import generate_presigned_urls_batch
from helpers.update_status import update_status

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
KB_SECRET_NAME = os.environ["KB_SECRET_NAME"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]

# Cached resources
connection = None
secret_cache = {}

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager", region_name=REGION)

def _get_secret(secret_name: str, expect_json: bool = True):
    if secret_name in secret_cache:
        return secret_cache[secret_name]

    try:
        response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
        value = json.loads(response) if expect_json else response
        secret_cache[secret_name] = value
        return value
    except json.JSONDecodeError as e:
        logger.error(f"Failed to decode JSON for secret '{secret_name}': {e}")
        raise ValueError(f"Secret '{secret_name}' is not properly formatted as JSON.")
    except Exception as e:
        logger.error(f"Error fetching secret '{secret_name}': {e}")
        raise

def _connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
            db_secret = _get_secret(DB_SECRET_NAME, expect_json=True)
            connection_params = {
                'dbname': db_secret["dbname"],
                'user': db_secret["username"],
                'password': db_secret["password"],
                'host': RDS_PROXY_ENDPOINT,
                'port': db_secret["port"], 
                'sslmode': 'require'
            }
            connection = psycopg2.connect(**connection_params)
            logger.info("Connected to the database!")
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection

def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }

def _parse_body(event):
    body = {}
    raw_body = event.get("body")

    if not raw_body:
        return body

    try:
        if isinstance(raw_body, str):
            body = json.loads(raw_body)
        elif isinstance(raw_body, dict):
            body = raw_body
        else:
            raise ValueError("Unsupported body format")
    except Exception as e:
        logger.error("Failed to parse body: %s", e)
        raise ValueError("Invalid JSON body")

    return body

def handler(event, context=None):
    safe_event = {k: v for k, v in event.items() if k != 'body'}
    logger.info("Event: %s (body omitted)", json.dumps(safe_event))
    
    try:
        # Scheduler polling path
        if event.get("task") == "poll_ingestion_run":
            try:
                connection = _connect_to_db()
            except Exception as e:
                logger.error(f"Error connecting to database: {e}")
                return _response(event, 500, {"error": "Error connecting to database"})

            return update_status(event=event, connection=connection)

        # API Gateway path
        method = event.get("httpMethod", "")
        resource = event.get("resource", "")
        path = event.get("path", "")

        # Route: GET /admin/generate-presigned-url
        if method == "GET" and (
            resource == "/admin/generate-presigned-url"
            or path.endswith("/admin/generate-presigned-url")
        ):
            return generate_presigned_url(event=event)

        # Route: POST /admin/generate-presigned-urls/batch
        if method == "POST" and (
            resource == "/admin/generate-presigned-urls/batch"
            or path.endswith("/admin/generate-presigned-urls/batch")
        ):
            try:
                body = _parse_body(event)
            except ValueError as e:
                return _response(event, 400, {"error": str(e)})
            return generate_presigned_urls_batch(event=event, body=body)

        try:
            body = _parse_body(event)
        except ValueError as e:
            return _response(event, 400, {"error": str(e)})
        
        # connect to database
        try:
            connection = _connect_to_db()
        except Exception as e:
            logger.error(f"Error connecting to database: {e}")
            return _response(event, 500, {"error": "Error connecting to database"})

        # Route: POST /admin/data_sources
        if method == "POST" and (
            resource == "/admin/data_sources"
            or path.endswith("/admin/data_sources")
        ):
            return stage_data_sources(event=event, body=body, connection=connection)

        # Route: POST /admin/data_sources/batch
        if method == "POST" and (
            resource == "/admin/data_sources/batch"
            or path.endswith("/admin/data_sources/batch")
        ):
            return stage_data_sources_batch(event=event, body=body, connection=connection)

        # Everything below this point needs KB ID
        try:
            kb_id = _get_secret(KB_SECRET_NAME, expect_json=False)
        except Exception as e:
            logger.error(f"Error getting knowledge base ID: {e}")
            return _response(event, 500, {"error": "Error getting knowledge base ID"})

        # Route: POST /admin/data_sources/sync
        if method == "POST" and (
            resource == "/admin/data_sources/sync"
            or path.endswith("/admin/data_sources/sync")
        ):
            return start_ingestion_job(
                event=event,
                body=body,
                connection=connection,
                kb_id=kb_id,
            )

        return _response(
            event,
            404,
            {
                "error": "Route not found",
                "method": method,
                "resource": resource,
                "path": path,
            },
        )

    except Exception as e:
        logger.error("Error: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Internal server error"})