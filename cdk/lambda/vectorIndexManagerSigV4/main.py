import json
import logging
from urllib.parse import urlparse

import boto3
from opensearchpy import OpenSearch, RequestsHttpConnection, exceptions
from requests_aws4auth import AWS4Auth

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def normalize_endpoint(endpoint: str) -> str:
    trimmed = str(endpoint or "").strip()
    if not trimmed:
        raise ValueError("CollectionEndpoint is required")
    if not trimmed.startswith("https://") and not trimmed.startswith("http://"):
        trimmed = f"https://{trimmed}"
    return trimmed.rstrip("/")

def build_client(endpoint: str, region: str) -> OpenSearch:
    session = boto3.Session()
    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError("Unable to load AWS credentials for SigV4 signing")
    frozen = credentials.get_frozen_credentials()

    auth = AWS4Auth(
        frozen.access_key,
        frozen.secret_key,
        region,
        "aoss",
        session_token=frozen.token,
    )

    normalized = normalize_endpoint(endpoint)
    parsed = urlparse(normalized)
    host = parsed.netloc or parsed.path
    if "/" in host:
        host = host.split("/")[0]

    return OpenSearch(
        hosts=[{"host": host, "port": 443}],
        http_auth=auth,
        use_ssl=True,
        verify_certs=True,
        connection_class=RequestsHttpConnection,
        timeout=30,
        retry_on_timeout=False,
        max_retries=0,
    )

def error_message(error: Exception) -> str:
    info = getattr(error, "info", None)
    if isinstance(info, str):
        return info
    if info is not None:
        try:
            return json.dumps(info)
        except Exception:
            return str(info)
    return str(error)

def is_index_already_exists(error_text: str) -> bool:
    text = error_text.lower()
    return "resource_already_exists_exception" in text or "already exists" in text

def get_index_body(props: dict) -> dict:
    vector_field = props.get("VectorField")
    text_field = props.get("TextField")
    metadata_field = props.get("MetadataField")
    dimensions = int(props.get("Dimensions", 1024))

    return {
        "settings": {
            "index": {
                "knn": True
            }
        },
        "mappings": {
            "properties": {
                vector_field: {
                    "type": "knn_vector",
                    "dimension": dimensions,
                    "method": {
                        "engine": "faiss",
                        "name": "hnsw",
                        "space_type": "l2"
                    }
                },
                text_field: {
                    "type": "text"
                },
                metadata_field: {
                    "type": "text",
                    "index": False
                }
            }
        }
    }

def handler(event, context):
    logger.info("Received event: %s", json.dumps(event))
    
    # CDK Async Provider adds "IsCompleteChain" or passes back "Data" when polling.
    # We can determine if this is the initial invocation or a polling invocation.
    is_polling = "IsCompleteChain" in event or "Data" in event
    
    if is_polling:
        return handle_is_complete(event)
    else:
        return handle_on_event(event)

def handle_on_event(event):
    logger.info("Executing onEvent phase")
    request_type = event.get("RequestType")
    props = event.get("ResourceProperties") or {}
    index_name = props.get("IndexName")
    
    if not index_name:
        raise ValueError("IndexName is required resource property")

    existing_physical_id = event.get("PhysicalResourceId")
    physical_resource_id = existing_physical_id if existing_physical_id else f"{index_name}-vector-index"

    # We do not block or sleep here. We acknowledge the request and pass to the polling phase.
    return {
        "PhysicalResourceId": physical_resource_id,
        "Data": {
            "IndexName": index_name,
            "Phase": "Polling" # Custom flag to guarantee we know it's the polling phase next time
        }
    }

def handle_is_complete(event):
    logger.info("Executing isComplete phase")
    request_type = event.get("RequestType")
    
    if request_type == "Delete":
        return {"IsComplete": True}

    props = event.get("ResourceProperties") or {}
    endpoint = props.get("CollectionEndpoint")
    region = props.get("Region")
    index_name = props.get("IndexName")

    client = build_client(endpoint, region)
    body = get_index_body(props)

    try:
        if client.indices.exists(index=index_name):
            client.indices.get(index=index_name)
            logger.info("Index '%s' is visible, readable, and ready.", index_name)
            return {"IsComplete": True}

        logger.info("Attempting to create index '%s'...", index_name)
        client.indices.create(index=index_name, body=body)
        
        logger.info("Index '%s' created successfully. Forcing one more polling cycle for stabilization.", index_name)
        return {"IsComplete": False}

    except exceptions.TransportError as error:
        status_code = getattr(error, "status_code", 0)
        text = error_message(error).lower()
        
        if is_index_already_exists(text):
            logger.info("Caught race condition: Index already exists. Stabilizing next cycle.")
            return {"IsComplete": False}

        transient_auth_or_readiness = (
            status_code in (401, 403, 404, 429, 500, 502, 503, 504)
            or "forbidden" in text
            or "authentication" in text
            or "unauthorized" in text
            or "no such index" in text
        )

        if transient_auth_or_readiness:
            logger.warning("Transient error (status=%s). Waiting for AOSS policy propagation. Error: %s", status_code, text)
            return {"IsComplete": False}

        logger.error("Non-transient error encountered: %s", text)
        raise