# AWS Managed Keys Usage

This document lists every place in the CDK infrastructure where an AWS managed key (rather than a customer-managed KMS key) is used for encryption, and describes exactly what code changes are required if you want to bring your own key (CMK).

---

## 1. RDS Instance — `cdk/lib/database-stack.ts`

**Current behaviour**

`storageEncrypted: true` is set on the `DatabaseInstance` construct without a `storageEncryptionKey` property. AWS therefore encrypts the RDS storage volume using the AWS managed key for RDS (`aws/rds`). Performance Insights is enabled but no `performanceInsightEncryptionKey` is set, so it also uses the AWS managed key.

```ts
// cdk/lib/database-stack.ts
this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
  ...
  storageEncrypted: true, // uses aws/rds managed key
  enablePerformanceInsights: true,
  performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
  ...
});
```

**To use a CMK**

1. Create (or import) a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const rdsKey = new kms.Key(this, "RdsEncryptionKey", {
     enableKeyRotation: true,
     description: "CMK for RDS storage encryption",
   });
   ```
2. Add `storageEncryptionKey` and `performanceInsightEncryptionKey` to the `DatabaseInstance` definition:
   ```ts
   this.dbInstance = new rds.DatabaseInstance(this, `${id}-database`, {
     ...
     storageEncrypted: true,
     storageEncryptionKey: rdsKey,
     performanceInsightEncryptionKey: rdsKey,
     ...
   });
   ```

---

## 2. Secrets Manager Secrets — `cdk/lib/api-stack.ts` and `cdk/lib/database-stack.ts`

**Current behaviour**

All `secretsmanager.Secret` constructs are created without an `encryptionKey` property. Secrets Manager therefore encrypts them using the AWS managed key for Secrets Manager (`aws/secretsmanager`).

The affected secrets are:

| Secret | File | Variable |
|---|---|---|
| Cognito credentials | `api-stack.ts` | `this.secret` (`${id}-KBA_Cognito_Secrets`) |
| RDS application user credentials | `database-stack.ts` | `this.secretPathUser` |
| RDS table creator credentials | `database-stack.ts` | `this.secretPathTableCreator` |

```ts
// Example from api-stack.ts — same pattern applies to all three secrets
this.secret = new secretsmanager.Secret(this, secretsName, {
  secretName: secretsName,
  // no encryptionKey — uses aws/secretsmanager managed key
  ...
});
```

**To use a CMK**

1. Create a KMS key (one shared key or one per secret, depending on your policy requirements):
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const secretsKey = new kms.Key(this, "SecretsEncryptionKey", {
     enableKeyRotation: true,
     description: "CMK for Secrets Manager secrets",
   });
   ```
2. Add the `encryptionKey` property to each `secretsmanager.Secret` definition:
   ```ts
   this.secret = new secretsmanager.Secret(this, secretsName, {
     secretName: secretsName,
     encryptionKey: secretsKey, // add this line
     ...
   });
   ```
   Repeat for `this.secretPathUser` and `this.secretPathTableCreator`.
3. Any IAM role that calls `secretsmanager:GetSecretValue` on these secrets will also need `kms:Decrypt` on the key. The CDK `grantRead` helper on a secret automatically adds the required KMS permissions when an `encryptionKey` is set, so existing `grantRead` calls do not need to change. For roles that use inline `PolicyStatement` instead of `grantRead`, add:
   ```ts
   secretsKey.grantDecrypt(lambdaRole);
   secretsKey.grantDecrypt(coglambdaRole);
   ```
4. The Glue IAM role reads these secrets via an inline `PolicyStatement` (not `grantRead`), so you must also grant:
   ```ts
   secretsKey.grantDecrypt(glueRole);
   ```

---

## 3. S3 Buckets — `cdk/lib/cicd-stack.ts`

**Current behaviour**

Both `PipelineArtifactBucket` and `ArtifactAccessLogs` are created without an `encryption` or `encryptionKey` property. CDK defaults to SSE-S3 (`AES256`), which uses the AWS managed key for S3 (`aws/s3`).

```ts
// cdk/lib/cicd-stack.ts
const artifactAccessLogsBucket = new s3.Bucket(this, "ArtifactAccessLogs", {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});

const artifactBucket = new s3.Bucket(this, "PipelineArtifactBucket", {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const pipelineKey = new kms.Key(this, "PipelineArtifactKey", {
     enableKeyRotation: true,
     description: "CMK for CodePipeline artifact buckets",
   });
   ```
2. Add `encryption` and `encryptionKey` to both bucket definitions:
   ```ts
   const artifactAccessLogsBucket = new s3.Bucket(this, "ArtifactAccessLogs", {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: pipelineKey,
   });

   const artifactBucket = new s3.Bucket(this, "PipelineArtifactBucket", {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: pipelineKey,
   });
   ```
3. Grant the CodeBuild role and the CodePipeline service permission to use the key:
   ```ts
   pipelineKey.grantEncryptDecrypt(codeBuildRole);
   pipelineKey.grant(new iam.ServicePrincipal("codepipeline.amazonaws.com"), "kms:GenerateDataKey", "kms:Decrypt");
   ```

---

## 4. ECR Repositories — `cdk/lib/cicd-stack.ts`

**Current behaviour**

One ECR repository is created per Lambda function in `props.lambdaFunctions`. None of them specify an `encryptionKey` property, so ECR uses AES-256 with the AWS managed key (`aws/ecr`).

```ts
// cdk/lib/cicd-stack.ts
const ecrRepo = new ecr.Repository(this, `${lambda.name}Repo`, {
  repositoryName: repoName,
  imageTagMutability: ecr.TagMutability.IMMUTABLE,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  imageScanOnPush: true,
  // no encryptionKey — uses aws/ecr managed key
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const ecrKey = new kms.Key(this, "EcrEncryptionKey", {
     enableKeyRotation: true,
     description: "CMK for ECR repositories",
   });
   ```
2. Add `encryptionKey` to each `ecr.Repository` definition:
   ```ts
   const ecrRepo = new ecr.Repository(this, `${lambda.name}Repo`, {
     ...
     encryptionKey: ecrKey,
   });
   ```
3. Grant the CodeBuild role permission to use the key:
   ```ts
   ecrKey.grantEncryptDecrypt(codeBuildRole);
   ```

---

## 5. S3 Buckets — `cdk/lib/api-stack.ts`

**Current behaviour**

`ExportAccessLogs` is created without any `encryption` property (defaults to SSE-S3). `ExportBucket` explicitly sets `encryption: s3.BucketEncryption.S3_MANAGED`, which is also SSE-S3 — neither uses a KMS key.

```ts
// cdk/lib/api-stack.ts
const exportAccessLogsBucket = new s3.Bucket(this, `${id}-ExportAccessLogs`, {
  // no encryption property — defaults to SSE-S3 (aws/s3)
  ...
});

const exportBucket = new s3.Bucket(this, `${id}-ExportBucket`, {
  encryption: s3.BucketEncryption.S3_MANAGED, // SSE-S3, not KMS
  ...
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const exportKey = new kms.Key(this, "ExportBucketKey", {
     enableKeyRotation: true,
     description: "CMK for export S3 buckets",
   });
   ```
2. Update both bucket definitions:
   ```ts
   const exportAccessLogsBucket = new s3.Bucket(this, `${id}-ExportAccessLogs`, {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: exportKey,
   });

   const exportBucket = new s3.Bucket(this, `${id}-ExportBucket`, {
     ...
     encryption: s3.BucketEncryption.KMS,
     encryptionKey: exportKey,
   });
   ```
3. Grant the export Lambda role permission to use the key:
   ```ts
   exportKey.grantEncryptDecrypt(exportLambdaRole);
   ```

---

## 6. SQS Queues — `cdk/lib/api-stack.ts`

**Current behaviour**

Both `ExportQueue` and `ExportDLQ` are created without an `encryption` or `encryptionMasterKey` property. SQS defaults to SSE-SQS (AWS managed key `aws/sqs`).

```ts
// cdk/lib/api-stack.ts
const exportDlq = new sqs.Queue(this, `${id}-ExportDLQ`, {
  // no encryption — uses aws/sqs managed key
  ...
});

const exportQueue = new sqs.Queue(this, `${id}-ExportQueue`, {
  // no encryption — uses aws/sqs managed key
  ...
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const queueKey = new kms.Key(this, "ExportQueueKey", {
     enableKeyRotation: true,
     description: "CMK for export SQS queues",
   });
   ```
2. Add `encryptionMasterKey` to both queue definitions:
   ```ts
   const exportDlq = new sqs.Queue(this, `${id}-ExportDLQ`, {
     ...
     encryptionMasterKey: queueKey,
   });

   const exportQueue = new sqs.Queue(this, `${id}-ExportQueue`, {
     ...
     encryptionMasterKey: queueKey,
   });
   ```
3. Grant the Lambda role that enqueues messages permission to use the key:
   ```ts
   queueKey.grantEncryptDecrypt(exportLambdaRole);
   ```

---

## 7. SNS Topic — `cdk/lib/api-stack.ts`

**Current behaviour**

`NotificationTopic` is created without a `masterKey` property. SNS defaults to the AWS managed key (`aws/sns`).

```ts
// cdk/lib/api-stack.ts
const notificationTopic = new sns.Topic(this, `${id}-NotificationTopic`, {
  topicName: `${id}-admin-notifications`,
  displayName: "Admin Notifications",
  // no masterKey — uses aws/sns managed key
});
```

**To use a CMK**

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const snsKey = new kms.Key(this, "NotificationTopicKey", {
     enableKeyRotation: true,
     description: "CMK for admin notification SNS topic",
   });
   ```
2. Add `masterKey` to the topic definition:
   ```ts
   const notificationTopic = new sns.Topic(this, `${id}-NotificationTopic`, {
     topicName: `${id}-admin-notifications`,
     displayName: "Admin Notifications",
     masterKey: snsKey,
   });
   ```
3. Grant any Lambda that publishes to the topic permission to use the key:
   ```ts
   snsKey.grantEncryptDecrypt(publisherLambdaRole);
   ```
   Lambda consumers subscribed to the topic also need decrypt access:
   ```ts
   snsKey.grantDecrypt(consumerLambdaRole);
   ```

---

## 8. AWS Glue Job — `cdk/lib/glue-stack.ts`

**Current behaviour**

The `PythonShellJob` is created without a `securityConfiguration` property. This means Glue job bookmarks, CloudWatch logs written by the job, and any S3 data the job writes are **not encrypted with a CMK** — they use the respective service defaults.

```ts
// cdk/lib/glue-stack.ts
const glueJob = new glue.PythonShellJob(this, `${id}-GlueJob`, {
  jobName: this.jobName,
  role: glueRole,
  script: glue.Code.fromAsset("./glue/sharepoint_ingestion.py"),
  // no securityConfiguration — no CMK for job data
  ...
});
```

**To use a CMK**

The `@aws-cdk/aws-glue-alpha` `PythonShellJob` does not expose `securityConfiguration` as a typed prop. Use the L1 escape hatch to attach one after creation.

1. Create a KMS key:
   ```ts
   import * as kms from "aws-cdk-lib/aws-kms";

   const glueKey = new kms.Key(this, "GlueEncryptionKey", {
     enableKeyRotation: true,
     description: "CMK for Glue job security configuration",
   });
   ```
2. Create a `CfnSecurityConfiguration` resource:
   ```ts
   import * as glue_cfn from "aws-cdk-lib/aws-glue";

   const glueSecurityConfig = new glue_cfn.CfnSecurityConfiguration(
     this,
     `${id}-GlueSecurityConfig`,
     {
       name: `${id}-security-config`,
       encryptionConfiguration: {
         s3Encryptions: [
           { s3EncryptionMode: "SSE-KMS", kmsKeyArn: glueKey.keyArn },
         ],
         cloudWatchEncryption: {
           cloudWatchEncryptionMode: "SSE-KMS",
           kmsKeyArn: glueKey.keyArn,
         },
         jobBookmarksEncryption: {
           jobBookmarksEncryptionMode: "CSE-KMS",
           kmsKeyArn: glueKey.keyArn,
         },
       },
     }
   );
   ```
3. Attach it to the job via the L1 escape hatch:
   ```ts
   (glueJob.node.defaultChild as cdk.CfnResource).addPropertyOverride(
     "SecurityConfiguration",
     glueSecurityConfig.name
   );
   ```
4. Grant the Glue role permission to use the key:
   ```ts
   glueKey.grantEncryptDecrypt(glueRole);
   ```
5. If the Secrets Manager secrets read by the Glue role (see section 2) are also CMK-encrypted, add:
   ```ts
   secretsKey.grantDecrypt(glueRole);
   ```

---

## Summary

| Resource | Stack file | AWS managed key used | Property to add for CMK |
|---|---|---|---|
| RDS instance storage + Performance Insights | `database-stack.ts` | `aws/rds` | `storageEncryptionKey` + `performanceInsightEncryptionKey` on `DatabaseInstance` |
| Secrets Manager secrets (×3) | `api-stack.ts`, `database-stack.ts` | `aws/secretsmanager` | `encryptionKey` on each `Secret` |
| S3 pipeline artifact buckets (×2) | `cicd-stack.ts` | `aws/s3` (SSE-S3) | `encryption: BucketEncryption.KMS` + `encryptionKey` on each `Bucket` |
| ECR repositories (×N) | `cicd-stack.ts` | `aws/ecr` (AES-256) | `encryptionKey` on each `Repository` |
| S3 export buckets (×2) | `api-stack.ts` | `aws/s3` (SSE-S3) | `encryption: BucketEncryption.KMS` + `encryptionKey` on each `Bucket` |
| SQS queues (×2) | `api-stack.ts` | `aws/sqs` (SSE-SQS) | `encryptionMasterKey` on each `Queue` |
| SNS topic | `api-stack.ts` | `aws/sns` | `masterKey` on `Topic` |
| Glue job data (S3, CloudWatch logs, bookmarks) | `glue-stack.ts` | service defaults (`aws/s3`, `aws/logs`) | `CfnSecurityConfiguration` + L1 escape hatch override |
