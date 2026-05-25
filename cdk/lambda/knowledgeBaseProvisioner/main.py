import json
import boto3
import logging
import time
import random

logger = logging.getLogger()
logger.setLevel(logging.INFO)

bedrock_agent = boto3.client('bedrock-agent')

# Reduced window because the index is already guaranteed to exist.
# This only accounts for Bedrock's internal cache delays.
KB_CREATE_RETRY_WINDOW_SECONDS = 120 

def calculate_exponential_backoff(attempt, base=2, max_sleep=15): 
    sleep_time = min(base**attempt, max_sleep)
    sleep_time *= (0.5 + random.random() / 2)
    return sleep_time

def _create_kb_and_data_sources(props):
    name = props['Name']
    role_arn = props['RoleArn']
    embedding_model_arn = props['EmbeddingModelArn']
    collection_arn = props['CollectionArn']
    vector_index_name = props['VectorIndexName']
    vector_field = props['VectorField']
    text_field = props['TextField']
    metadata_field = props['MetadataField']
    description = props.get('Description', '')

    logger.info(f"Creating Knowledge Base: {name}")

    deadline = time.time() + KB_CREATE_RETRY_WINDOW_SECONDS
    attempt = 0
    while True:
        attempt += 1
        try:
            response = bedrock_agent.create_knowledge_base(
                name=name,
                description=description,
                roleArn=role_arn,
                knowledgeBaseConfiguration={
                    'type': 'VECTOR',
                    'vectorKnowledgeBaseConfiguration': {
                        'embeddingModelArn': embedding_model_arn
                    }
                },
                storageConfiguration={
                    'type': 'OPENSEARCH_SERVERLESS',
                    'opensearchServerlessConfiguration': {
                        'collectionArn': collection_arn,
                        'vectorIndexName': vector_index_name,
                        'fieldMapping': {
                            'vectorField': vector_field,
                            'textField': text_field,
                            'metadataField': metadata_field
                        }
                    }
                }
            )
            break
        except bedrock_agent.exceptions.ValidationException as e:
            message = str(e)
            is_index_not_ready = (
                "no such index" in message.lower()
                or "storage configuration provided is invalid" in message.lower()
            )

            if is_index_not_ready:
                sleep_time = calculate_exponential_backoff(attempt)
                
                if time.time() + sleep_time > deadline:
                    logger.error(f"Bedrock failed to recognize the index after {KB_CREATE_RETRY_WINDOW_SECONDS} seconds.")
                    raise

                seconds_left = int(deadline - time.time())
                logger.warning(
                    "Bedrock API cache has not recognized the index yet. "
                    "Retrying in %.1fs (time left: %ss). Error: %s",
                    sleep_time,
                    seconds_left,
                    message,
                )          
                time.sleep(sleep_time)
                continue
            raise

    kb_id = response['knowledgeBase']['knowledgeBaseId']
    logger.info(f"Successfully created Knowledge Base. ID: {kb_id}")

    s3_ds_id = ''
    web_ds_id = ''

    s3_bucket_arn = props.get('S3BucketArn')
    if s3_bucket_arn:
        logger.info(f"Creating S3 Data Source for bucket: {s3_bucket_arn}")
        ds_response = bedrock_agent.create_data_source(
            knowledgeBaseId=kb_id,
            name=f"{name}-s3-source",
            dataSourceConfiguration={
                'type': 'S3',
                's3Configuration': {
                    'bucketArn': s3_bucket_arn
                }
            },
            vectorIngestionConfiguration={
                'chunkingConfiguration': {
                    'chunkingStrategy': 'SEMANTIC',
                    'semanticChunkingConfiguration': {
                        'maxTokens': 512,
                        'bufferSize': 1,
                        'breakpointPercentileThreshold': 85
                    }
                }
            }
        )
        s3_ds_id = ds_response['dataSource']['dataSourceId']
        logger.info(f"Successfully created S3 Data Source. ID: {s3_ds_id}")

    web_urls_str = props.get('WebCrawlerUrls', '')
    if web_urls_str and web_urls_str != "dummy-value":
        urls = [url.strip() for url in web_urls_str.split(',') if url.strip()]
        if urls:
            logger.info(f"Creating Web Crawler Data Source for URLs: {urls}")
            try:
                exclusion_filters_str = props.get('WebCrawlerExclusionFilters', '')
                exclusion_filters = [f.strip() for f in exclusion_filters_str.split(',') if f.strip()]

                web_config = {
                    'sourceConfiguration': {
                        'urlConfiguration': {
                            'seedUrls': [{'url': url} for url in urls]
                        }
                    }
                }
                if exclusion_filters:
                    web_config['crawlerConfiguration'] = {
                        'exclusionFilters': exclusion_filters
                    }

                ds_response = bedrock_agent.create_data_source(
                    knowledgeBaseId=kb_id,
                    name=f"{name}-web-source",
                    dataSourceConfiguration={
                        'type': 'WEB',
                        'webConfiguration': web_config
                    },
                    vectorIngestionConfiguration={
                        'chunkingConfiguration': {
                            'chunkingStrategy': 'SEMANTIC',
                            'semanticChunkingConfiguration': {
                                'maxTokens': 512,
                                'bufferSize': 1,
                                'breakpointPercentileThreshold': 85
                            }
                        }
                    }
                )
                web_ds_id = ds_response['dataSource']['dataSourceId']
                logger.info(f"Successfully created Web Crawler Data Source. ID: {web_ds_id}")
            except Exception as e:
                logger.warning(f"Could not create Web Crawler Data Source. Error: {str(e)}")

    return {
        'kb_id': kb_id,
        's3_ds_id': s3_ds_id,
        'web_ds_id': web_ds_id,
    }


def _ensure_data_sources_for_kb(kb_id, props):
    name = props['Name']
    s3_ds_id = ''
    web_ds_id = ''

    response = bedrock_agent.list_data_sources(knowledgeBaseId=kb_id)
    for ds in response.get('dataSourceSummaries', []):
        ds_name = ds.get('name', '')
        ds_id = ds.get('dataSourceId', '')
        if ds_name == f"{name}-s3-source":
            s3_ds_id = ds_id
        elif ds_name == f"{name}-web-source":
            web_ds_id = ds_id

    if not s3_ds_id and props.get('S3BucketArn'):
        logger.info("S3 data source missing on update; creating it.")
        ds_response = bedrock_agent.create_data_source(
            knowledgeBaseId=kb_id,
            name=f"{name}-s3-source",
            dataSourceConfiguration={
                'type': 'S3',
                's3Configuration': {
                    'bucketArn': props.get('S3BucketArn')
                }
            },
            vectorIngestionConfiguration={
                'chunkingConfiguration': {
                    'chunkingStrategy': 'SEMANTIC',
                    'semanticChunkingConfiguration': {
                        'maxTokens': 512,
                        'bufferSize': 1,
                        'breakpointPercentileThreshold': 85
                    }
                }
            }
        )
        s3_ds_id = ds_response['dataSource']['dataSourceId']

    web_urls_str = props.get('WebCrawlerUrls', '')
    if not web_ds_id and web_urls_str and web_urls_str != "dummy-value":
        urls = [url.strip() for url in web_urls_str.split(',') if url.strip()]
        if urls:
            logger.info("Web data source missing on update; creating it.")
            exclusion_filters_str = props.get('WebCrawlerExclusionFilters', '')
            exclusion_filters = [f.strip() for f in exclusion_filters_str.split(',') if f.strip()]

            web_config = {
                'sourceConfiguration': {
                    'urlConfiguration': {
                        'seedUrls': [{'url': url} for url in urls]
                    }
                }
            }
            if exclusion_filters:
                web_config['crawlerConfiguration'] = {
                    'exclusionFilters': exclusion_filters
                }

            ds_response = bedrock_agent.create_data_source(
                knowledgeBaseId=kb_id,
                name=f"{name}-web-source",
                dataSourceConfiguration={
                    'type': 'WEB',
                    'webConfiguration': web_config
                },
                vectorIngestionConfiguration={
                    'chunkingConfiguration': {
                        'chunkingStrategy': 'SEMANTIC',
                        'semanticChunkingConfiguration': {
                            'maxTokens': 512,
                            'bufferSize': 1,
                            'breakpointPercentileThreshold': 85
                        }
                    }
                }
            )
            web_ds_id = ds_response['dataSource']['dataSourceId']

    return s3_ds_id, web_ds_id

def handler(event, context):
    logger.info(f"Received event: {json.dumps(event)}")
    request_type = event['RequestType']
    
    try:
        if request_type == 'Create':
            return on_create(event)
        elif request_type == 'Update':
            return on_update(event)
        elif request_type == 'Delete':
            return on_delete(event)
        else:
            raise Exception(f"Invalid request type: {request_type}")
    except Exception as e:
        logger.error(f"Error handling event: {str(e)}")
        raise e

def on_create(event):
    props = event['ResourceProperties']
    created = _create_kb_and_data_sources(props)
    kb_id = created['kb_id']

    return {
        'PhysicalResourceId': kb_id,
        'Data': {
            'KnowledgeBaseId': kb_id,
            'S3DataSourceId': created['s3_ds_id'],
            'WebCrawlerDataSourceId': created['web_ds_id']
        }
    }

def on_update(event):
    physical_id = event['PhysicalResourceId']
    props = event.get('ResourceProperties', {})

    s3_ds_id = ''
    web_ds_id = ''
    effective_kb_id = physical_id

    try:
        bedrock_agent.get_knowledge_base(knowledgeBaseId=physical_id)
        s3_ds_id, web_ds_id = _ensure_data_sources_for_kb(physical_id, props)
        logger.info(f"Update operation requested for: {physical_id}. Returning existing attributes.")
    except bedrock_agent.exceptions.ResourceNotFoundException:
        logger.warning(
            f"Knowledge Base {physical_id} not found during update. Recreating knowledge base and data sources."
        )
        created = _create_kb_and_data_sources(props)
        effective_kb_id = created['kb_id']
        s3_ds_id = created['s3_ds_id']
        web_ds_id = created['web_ds_id']
    except Exception as e:
        logger.error(f"Update failed while reconciling knowledge base/data sources: {str(e)}")
        raise

    return {
        'PhysicalResourceId': effective_kb_id,
        'Data': {
            'KnowledgeBaseId': effective_kb_id,
            'S3DataSourceId': s3_ds_id,
            'WebCrawlerDataSourceId': web_ds_id
        }
    }

def on_delete(event):
    kb_id = event['PhysicalResourceId']
    if kb_id and kb_id != 'failed-to-create' and not kb_id.startswith('CustomResource'):
        try:
            logger.info(f"Deleting Knowledge Base: {kb_id}")
            bedrock_agent.delete_knowledge_base(knowledgeBaseId=kb_id)
            logger.info(f"Successfully deleted Knowledge Base: {kb_id}")
        except bedrock_agent.exceptions.ResourceNotFoundException:
            logger.info(f"Knowledge Base {kb_id} already deleted.")
        except Exception as e:
            logger.error(f"Error deleting knowledge base: {str(e)}")
            raise e
    return {
        'PhysicalResourceId': event['PhysicalResourceId'],
        'Data': {}
    }