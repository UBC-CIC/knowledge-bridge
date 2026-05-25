# ECR Image Waiter Custom Resource

## Purpose

This custom resource prevents deployment race conditions where Docker-based Lambda functions are created before their container images are built and pushed to ECR.

## Problem

When deploying CDK stacks with the following dependency chain:

1. **CICD Stack** creates ECR repositories and CodePipeline
2. **API Stack** creates Docker-based Lambda functions that reference ECR images

CloudFormation's stack dependency (`apiStack.addDependency(cicdStack)`) only ensures the CICD stack **resources** are created (ECR repos, pipeline definition), but **NOT** that the pipeline has actually run and built the images.

This causes the API stack deployment to fail on first run because:

- ECR repositories exist ✅
- Docker images in those repositories do NOT exist ❌
- Lambda functions cannot be created without valid images ❌

## Solution

The ECR Image Waiter custom resource:

1. **Waits** for Docker images to exist in ECR repositories
2. **Retries** with configurable delay (default: 30 seconds between retries)
3. **Times out** after a configurable period (default: 30 minutes)
4. **Blocks** the creation of Docker Lambda functions until images are confirmed to exist

## Architecture

```
┌─────────────────────┐
│   CICD Stack        │
│                     │
│ ┌─────────────────┐ │
│ │ ECR Repos       │ │
│ │ - textGen       │ │
│ │ - pracMaterial  │ │
│ └─────────────────┘ │
│                     │
│ ┌─────────────────┐ │
│ │ CodePipeline    │ │
│ │ (builds images) │ │
│ └─────────────────┘ │
└─────────────────────┘
          │
          │ Stack dependency
          ▼
┌─────────────────────┐
│   API Stack         │
│                     │
│ ┌─────────────────┐ │
│ │ Image Waiter    │ │◄── Custom Resource Lambda
│ │ Custom Resource │ │    (checks ECR for images)
│ └─────────────────┘ │
│          │          │
│          │ Dependency
│          ▼          │
│ ┌─────────────────┐ │
│ │ Docker Lambda   │ │
│ │ Functions       │ │
│ └─────────────────┘ │
└─────────────────────┘
```

## Implementation

### Files

- **`lambda/ecrImageWaiter/index.js`**: Custom resource Lambda handler
- **`lambda/ecrImageWaiter/package.json`**: Dependencies (@aws-sdk/client-ecr)
- **`lib/api-stack.ts`**:
  - Creates the ECR Image Waiter Lambda function
  - Creates custom resources for each Docker image
  - Adds dependencies to Docker Lambda functions

### Custom Resource Properties

| Property            | Type   | Default  | Description                            |
| ------------------- | ------ | -------- | -------------------------------------- |
| `RepositoryName`    | String | Required | ECR repository name to check           |
| `ImageTag`          | String | Required | Image tag to look for (e.g., "latest") |
| `MaxRetries`        | String | "60"     | Maximum number of retry attempts       |
| `RetryDelaySeconds` | String | "30"     | Seconds to wait between retries        |

### Default Behavior

- **Max wait time**: 30 minutes (60 retries × 30 seconds)
- **Check interval**: Every 30 seconds
- **On timeout**: CloudFormation rollback (deployment fails gracefully)

## How It Works

1. **API Stack deployment starts**
2. **Custom resource Lambda is created** (ecrImageWaiter)
3. **Custom resource invoked** for each Docker image:
   - Checks if image exists in ECR
   - If not found, waits 30 seconds and retries
   - Continues until image found or timeout
4. **On success**: CloudFormation proceeds to create Docker Lambda functions
5. **On failure**: CloudFormation rolls back the stack

## Deployment Workflow

### First-Time Deployment

```bash
# 1. Deploy CICD stack (creates repos and pipeline)
cdk deploy specEx-CICD

# 2. Trigger the pipeline (or wait for automatic webhook trigger)
# The pipeline will build and push Docker images

# 3. Deploy API stack
# The custom resource will wait for images, then create Lambda functions
cdk deploy specEx-Api
```

### Subsequent Deployments

The custom resource gracefully handles existing images, so subsequent deployments work normally without waiting.

## Monitoring

### CloudWatch Logs

The image waiter Lambda logs to CloudWatch:

- **Log Group**: `/aws/lambda/<StackPrefix>-Api-EcrImageWaiter`
- **Log content**:
  - Image check attempts
  - Retry count and delay
  - Success or failure status

### CloudFormation Events

Watch CloudFormation stack events to see:

- Custom resource CREATE_IN_PROGRESS (waiting for image)
- Custom resource CREATE_COMPLETE (image found)
- Lambda function CREATE_IN_PROGRESS (proceeding with deployment)

## Troubleshooting

### Symptom: Stack times out after 30 minutes

**Cause**: CodePipeline hasn't built the images yet

**Solutions**:

1. Check CodePipeline execution status in AWS Console
2. Ensure pipeline triggered correctly and isn't stuck
3. Manually trigger the pipeline before deploying API stack
4. Increase `MaxRetries` if pipeline takes longer than 30 minutes

### Symptom: Custom resource fails immediately

**Cause**: ECR repository doesn't exist

**Solution**: Ensure CICD stack deployed successfully first

### Symptom: Image exists but waiter still times out

**Cause**: IAM permissions issue

**Solution**: Verify the ecrImageWaiterRole has:

- `ecr:DescribeImages`
- `ecr:DescribeRepositories`
- `ecr:BatchGetImage`

## Configuration

To adjust wait times, modify the custom resource properties in `api-stack.ts`:

```typescript
const textGenImageWaiter = new cdk.CustomResource(this, "TextGenImageWaiter", {
  serviceToken: ecrImageWaiterFunction.functionArn,
  properties: {
    RepositoryName: props.ecrRepositories["textGeneration"].repositoryName,
    ImageTag: "latest",
    MaxRetries: "120", // Double the retries (60 minutes total)
    RetryDelaySeconds: "30",
  },
});
```

## Benefits

✅ **Prevents race conditions** between stack deployment and image building  
✅ **Automatic waiting** - no manual intervention needed  
✅ **Graceful failure** - CloudFormation rolls back if images never appear  
✅ **Idempotent** - works for both first-time and subsequent deployments  
✅ **Configurable timeouts** - adjust to your pipeline build times

## Cost Considerations

- **Lambda invocations**: 2 custom resource invocations per deployment
- **Lambda duration**: Up to 15 minutes per invocation (mostly waiting/sleeping)
- **CloudWatch Logs**: Minimal logging overhead

**Estimated cost**: < $0.01 per deployment
