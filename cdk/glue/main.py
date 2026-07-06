"""
SharePoint → pgvector ingestion job.

Job parameters (passed at runtime or from Glue defaults):
  --SHAREPOINT_SECRET_NAME          : KBA-SharePoint-Credentials
  --SHAREPOINT_CERT_SECRET          : Sharepoint-REST-Cert-Pfx-B64
  --SHAREPOINT_CERT_PASSWORD_SECRET : Sharepoint-REST-Cert-Pfx-Password
  --DB_SECRET_NAME                  : <secretPathUser secret name>
  --RDS_PROXY_ENDPOINT              : <rds proxy endpoint>
  --FORCE_FULL                      : "true" | "false"
  --TRIGGERED_BY                    : "manual" | "scheduled" | "system"
  --INGESTION_RUN_ID                : <uuid of the pre-created run row>
"""

import asyncio
import base64
import json
import logging
import os
import sys

import boto3
from botocore.config import Config
from azure.identity import CertificateCredential, ClientSecretCredential
from msgraph import GraphServiceClient

from awsglue.utils import getResolvedOptions

import db_repo
from chunking import semantic_chunk_text
from embedding import embed_texts
from graph import GraphContext, make_graph_headers_fn, make_sharepoint_headers_fn, resolve_site_url
from narration import narrate_fields
from orchestration import run_site_ingestion

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
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
# Job parameters
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

REGION = "ca-central-1"
LLM_REGION = "us-west-2"
EMBEDDING_MODEL_ID = "cohere.embed-english-v3"

# ---------------------------------------------------------------------------
# AWS clients
# ---------------------------------------------------------------------------
_bedrock_config = Config(read_timeout=60, connect_timeout=10, retries={"max_attempts": 3})

secrets_client = boto3.client("secretsmanager", region_name=REGION)
bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION, config=_bedrock_config)
bedrock_llm = boto3.client("bedrock-runtime", region_name=LLM_REGION, config=_bedrock_config)


def get_secret(secret_id: str) -> str:
    return secrets_client.get_secret_value(SecretId=secret_id)["SecretString"]


# ---------------------------------------------------------------------------
# Load secrets, init credentials, init DB
# ---------------------------------------------------------------------------
sp_creds = json.loads(get_secret(SHAREPOINT_SECRET_NAME))
TENANT_ID = sp_creds["tenant_id"]
CLIENT_ID = sp_creds["client_id"]
CLIENT_SECRET = sp_creds["client_secret"]
SITE_ID = sp_creds["site_id"]

pfx_b64 = get_secret(SHAREPOINT_CERT_SECRET)
pfx_password = get_secret(SHAREPOINT_CERT_PASSWORD_SECRET)
pfx_bytes = base64.b64decode(pfx_b64)

credential = ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET)
rest_credential = CertificateCredential(
    tenant_id=TENANT_ID,
    client_id=CLIENT_ID,
    certificate_data=pfx_bytes,
    password=pfx_password,
)
graph_client = GraphServiceClient(credential)

db_secret = json.loads(get_secret(DB_SECRET_NAME))
db_repo.init_db(RDS_PROXY_ENDPOINT, db_secret)

try:
    db_repo.get_conn()
    log(f"DB connection OK — host={RDS_PROXY_ENDPOINT}")
except Exception as _e:
    logger.error(f"DB connection FAILED — host={RDS_PROXY_ENDPOINT}: {_e}", exc_info=True)
    raise

log("Credentials and clients initialized.")

# ---------------------------------------------------------------------------
# Assemble context and bound callables
# ---------------------------------------------------------------------------
ctx = GraphContext(
    get_graph_headers=make_graph_headers_fn(credential),
    get_sharepoint_headers=make_sharepoint_headers_fn(rest_credential),
    resolve_site_url=resolve_site_url,
    graph_client=graph_client,
)


def _narrate(fields, list_title=None):
    return narrate_fields(fields, bedrock_llm, list_title=list_title)


def _embed(chunks):
    return embed_texts(chunks, bedrock_runtime, model_id=EMBEDDING_MODEL_ID)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
asyncio.run(run_site_ingestion(
    site_id=SITE_ID,
    ctx=ctx,
    narrate_fn=_narrate,
    chunk_fn=semantic_chunk_text,
    embed_fn=_embed,
    ingestion_run_id=INGESTION_RUN_ID,
    triggered_by=TRIGGERED_BY,
    force_full=FORCE_FULL,
))
log("Ingestion job complete.")
