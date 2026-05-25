# Dependency Management Guide

## Overview

This document explains how Python dependencies are locked and managed across Lambda functions in this project to ensure reproducible builds and security.

## Lambda Functions with Locked Dependencies

The `vectorIndexManagerSigV4` function is the only Lambda deployed as a Docker image built by CodePipeline, so exact version pinning is critical for reproducible builds.

| Lambda Function           | Location                              | Approach                      |
| ------------------------- | ------------------------------------- | ----------------------------- |
| `vectorIndexManagerSigV4` | `cdk/lambda/vectorIndexManagerSigV4/` | Locked via pip-tools (Docker) |

## How Dependencies Were Locked

### 1. Requirements Structure

The `vectorIndexManagerSigV4` function uses a two-file approach:

- `requirements.in` — High-level direct dependencies
- `requirements.txt` — All dependencies with exact pinned versions (generated from `requirements.in`)

### 2. Current Direct Dependencies (`requirements.in`)

```
opensearch-py>=2.8.0
requests-aws4auth>=1.3.1
boto3>=1.35.0
```

### 3. Locking Process

Dependencies are locked using pip-tools inside a locally built Docker container matching the Lambda runtime (`public.ecr.aws/lambda/python:3.12`).

```bash
# Navigate to the function directory
cd cdk/lambda/vectorIndexManagerSigV4

# Build the Docker image
docker build -t vectorindexmanager-img .

# Run pip-compile inside the container to generate requirements.txt
docker run --rm -v ${PWD}:/app -w /app --entrypoint="" vectorindexmanager-img bash -c "
  pip install pip-tools &&
  pip-compile requirements.in
"
```

### 4. Key Locked Dependencies

The current `requirements.txt` pins the following (generated for Python 3.12):

| Package | Pinned Version | Purpose |
|---|---|---|
| `opensearch-py` | 2.8.0 | OpenSearch Serverless client |
| `requests-aws4auth` | 1.3.1 | SigV4 request signing for AOSS |
| `boto3` | 1.42.91 | AWS SDK |
| `botocore` | 1.42.91 | AWS SDK core |
| `requests` | 2.33.1 | HTTP client (transitive) |
| `certifi` | 2026.2.25 | TLS certificates (transitive) |
| `urllib3` | 2.6.3 | HTTP library (transitive) |

## How to Modify Dependencies

### Adding New Dependencies

1. **Add to `requirements.in`:**

   ```
   # Example: add a new package
   some-package>=1.0.0
   ```

2. **Open Docker Desktop** and keep it running.

3. **Build the Docker image:**

   ```bash
   cd cdk/lambda/vectorIndexManagerSigV4
   docker build -t vectorindexmanager-img .
   ```

4. **Regenerate `requirements.txt`:**

   ```bash
   docker run --rm -v ${PWD}:/app -w /app --entrypoint="" vectorindexmanager-img bash -c "
     pip install pip-tools &&
     pip-compile requirements.in
   "
   ```

5. **Commit and push the changes:**

   **Option 1: Terminal**

   ```bash
   git add requirements.in requirements.txt
   git commit -m "Add new dependency to vectorIndexManagerSigV4"
   git push origin <branch-name>
   ```

   **Option 2: VS Code Source Control**

   1. Go to the Source Control tab.
   2. Stage `requirements.in` and `requirements.txt`.
   3. Write a commit message and click ✓ Commit.
   4. Click Push.

Once pushed, CodePipeline detects the change, rebuilds the Docker image, and redeploys the Lambda.

### Updating Existing Dependencies

1. **Update the version constraint in `requirements.in`:**

   ```
   # Change from:
   opensearch-py>=2.8.0
   # To:
   opensearch-py>=2.9.0
   ```

2. **Open Docker Desktop.**

3. **Build the Docker image:**

   ```bash
   cd cdk/lambda/vectorIndexManagerSigV4
   docker build -t vectorindexmanager-img .
   ```

4. **Regenerate `requirements.txt`:**

   ```bash
   docker run --rm -v ${PWD}:/app -w /app --entrypoint="" vectorindexmanager-img bash -c "
     pip install pip-tools &&
     pip-compile requirements.in
   "
   ```

5. **Commit and push** the updated `requirements.in` and `requirements.txt` to trigger the CI/CD pipeline.


