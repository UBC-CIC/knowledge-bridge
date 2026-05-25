import os
import json
import boto3

cached_allowed_origins = None

def get_cors_headers(event):
    global cached_allowed_origins
    if cached_allowed_origins is None:
        param_name = os.environ.get('ALLOWED_ORIGIN_PARAM')
        if not param_name:
            cached_allowed_origins = ["*"]
        else:
            try:
                ssm = boto3.client('ssm')
                response = ssm.get_parameter(Name=param_name)
                cached_allowed_origins = [s.strip().rstrip('/') for s in response['Parameter']['Value'].split(',')]
            except Exception as e:
                print(f"CRITICAL: Failed to fetch CORS origins from SSM — blocking all cross-origin requests: {e}")
                # Do not cache — allow retry on next request once SSM recovers
                return {
                    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                    "Access-Control-Allow-Methods": "*"
                }
    
    headers = event.get('headers', {}) if event else {}
    origin = headers.get('origin') or headers.get('Origin')
    allowed_origin = ""
    
    if "*" in cached_allowed_origins:
        allowed_origin = "*"
    elif origin in cached_allowed_origins:
        allowed_origin = origin
        
    cors_headers = {
        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Methods": "*"
    }
    if allowed_origin:
        cors_headers["Access-Control-Allow-Origin"] = allowed_origin
        
    return cors_headers