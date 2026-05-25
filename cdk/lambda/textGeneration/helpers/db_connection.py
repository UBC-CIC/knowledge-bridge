
import os
import boto3
import json
import psycopg2
import logging

logger = logging.getLogger(__name__)

# Environment variables
REGION = os.environ.get("REGION", "ca-central-1")
DB_SECRET_NAME = os.environ.get("SM_DB_CREDENTIALS")
RDS_PROXY_ENDPOINT = os.environ.get("RDS_PROXY_ENDPOINT")

# Cached resources
connection = None

# AWS Powertools
from aws_lambda_powertools.utilities import parameters

def get_secret():
    if not DB_SECRET_NAME:
        raise ValueError("SM_DB_CREDENTIALS environment variable not set")
        
    try:
        # Powertools caches for 5 mins (300 sec) and handles JSON parsing
        return parameters.get_secret(DB_SECRET_NAME, transform='json', max_age=300)
    except Exception as e:
        logger.error(f"Error retrieving secret {DB_SECRET_NAME}: {e}")
        raise e

def get_db_connection():
    global connection
    try:
        if connection is None or connection.closed:
            secret = get_secret()

            # If proxy endpoint is not set, fallback to secret's host (direct connection, might fail if in private subnet without VPC config?)
            host = RDS_PROXY_ENDPOINT if RDS_PROXY_ENDPOINT else secret.get('host')

            connection = psycopg2.connect(
                sslmode='require',
                host=host,
                user=secret.get('username'),
                password=secret.get('password'),
                dbname=secret.get('dbname'),
                port=secret.get('port', 5432)
            )
        return connection
    except Exception as e:
        if connection: 
            try: 
                connection.close()
            except: 
                logger.warning(f"Failed to close DB connection during cleanup: {close_err}")
            connection = None
        logger.error(f"Failed to connect to database: {e}")
        raise e
