# S3 Review — Knowledge Base Assistant

**Scope:** Review of Amazon S3 usage across the project for best practices, security, and cost — including the specific question of whether an S3 VPC endpoint should exist.

**Short answer on the VPC endpoint:** Yes — and it already does. Both VPC paths in `vpc-stack.ts` create an S3 **gateway** endpoint, which is the correct, no-cost choice. There is a placement gap in the existing-VPC path (see §4). The more material findings are around the **chat-exports bucket** (missing TLS enforcement, long-lived presigned URLs stored in the database) and **CICD access-log retention**.

---

## 1. Inventory — Where S3 Is Used

| Bucket / usage | Defined in | Purpose | Notes |
|----------------|-----------|---------|-------|
| `…-chat-exports` (ExportBucket) | `api-stack.ts` | Stores generated chat-history export JSON; served via presigned GET URLs | Holds potentially sensitive conversation data |
| `PipelineArtifactBucket` | `cicd-stack.ts` | CodePipeline build artifacts | Access logging enabled |
| `ArtifactAccessLogs` | `cicd-stack.ts` | S3 server access logs for the artifact bucket | No lifecycle rule |
| `aws-glue-assets-<acct>-<region>` | `glue-stack.ts` (referenced) | Glue script + temp assets | AWS-managed naming; IAM scoped to prefix |
| CDK asset staging + Glue `s3assets.Asset` | `api-stack.ts`, `glue-stack.ts` | Synth-time asset upload (OpenAPI spec, Glue script) | Managed by CDK bootstrap |
| **S3 gateway VPC endpoint** | `vpc-stack.ts` (both paths) | Keeps in-VPC S3 traffic off the NAT Gateway | See §4 |

**Application data-path S3 clients:**
- `exportProcessorHandler.js` — `PutObject` the export, then `getSignedUrl` (GET) with a **7-day** expiry.
- Glue `sharepoint_ingestion.py` — uses `secretsmanager` and `bedrock-runtime`; no direct app-bucket S3 (KB content comes from SharePoint → Glue → pgvector, not S3).

**Note / discrepancy:** `Docs/API_DOCUMENTATION.md` and the WAF rules reference `POST /admin/generate-presigned-urls/batch` and `/admin/data_sources/batch` for **file uploads**, but there is **no upload/data-source bucket or `s3:PutObject` grant** in the current CDK. This looks like a leftover from an earlier S3-based knowledge-base design (the system has since pivoted to SharePoint ingestion). Worth confirming the endpoint is still wired to a real bucket, or removing it from the docs/WAF if dead. (See §6.)

---

## 2. What's Already Good

- `cdk.json` sets `@aws-cdk/aws-s3:publicAccessBlockedByDefault: true` and `@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy: true` — new buckets get Block Public Access by default and use bucket policies for access logging.
- Export bucket: `blockPublicAccess: BLOCK_ALL`, `encryption: S3_MANAGED`, and a **30-day lifecycle expiration** — good hygiene for ephemeral exports.
- CICD buckets: `BLOCK_ALL` + `enforceSSL: true`, and the artifact bucket has **server access logging** configured.
- S3 access from inside the VPC uses a **gateway endpoint** (free, same-region) rather than routing through NAT or using a paid interface endpoint.

---

## 3. Security Findings

### 3.1 Export bucket does not enforce TLS (Medium)
The CICD buckets set `enforceSSL: true`, but the **chat-exports bucket does not**. Without it, the bucket policy doesn't deny `aws:SecureTransport=false`, so non-HTTPS requests aren't explicitly rejected.

```ts
const exportBucket = new s3.Bucket(this, `${id}-ExportBucket`, {
  // ...
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,   // <-- add this
});
```

**Recommendation:** Add `enforceSSL: true` to match the CICD buckets and align with the project's "encrypt/secure by default" posture.

### 3.2 Long-lived presigned URLs, stored in the database (Medium → High depending on data sensitivity)
`exportProcessorHandler.js` generates a presigned **GET** URL with `expiresIn: 604800` (**7 days**) and writes it into the `export_runs.presigned_url` Postgres column.

Two issues compound here:
- **7 days is a long window** for anonymous, credential-free access to exported chat data (which may contain PII even after upstream PII stripping).
- **Persisting the presigned URL** in the database means anyone with read access to that row (or a DB backup, log, or export of the table) gets a working, unauthenticated download link for the remainder of the window.

**Recommendations:**
- Store only `s3_key` in the database; **generate the presigned URL on demand** at download time, behind the existing Cognito-authenticated admin endpoint.
- Shorten the TTL substantially (minutes to a few hours) to match an interactive download flow.
- If exports must persist for days, gate download through the API/authorizer rather than a long-lived signed URL.

### 3.3 SSE-S3 vs SSE-KMS for sensitive exports (Low → Medium)
The export bucket uses `S3_MANAGED` (SSE-S3). For data classified as sensitive (chat transcripts), **SSE-KMS with a customer-managed key** adds key-level access control, CloudTrail key-usage audit, and the ability to revoke access by disabling the key. Enable **S3 Bucket Keys** alongside KMS to control request cost.

**Recommendation:** Decide based on the data classification of exported conversations. If they're considered sensitive, switch the export bucket to SSE-KMS (CMK) + Bucket Keys. SSE-S3 is acceptable for non-sensitive data.

### 3.4 CICD access-logs bucket — confirm encryption/SSL (Low)
`ArtifactAccessLogs` sets `BLOCK_ALL` and `enforceSSL: true` but no explicit encryption. S3 encrypts new objects with SSE-S3 by default, so this is acceptable; making it explicit is a minor clarity improvement.

---

## 4. The S3 VPC Endpoint — Detailed Answer

**Should there be an S3 VPC endpoint?** Yes, and one exists. The key points:

- **Type is correct.** A **gateway** endpoint (not interface) is the right choice for S3 access from within the VPC in the same region. Gateway endpoints have **no hourly charge and no per-GB data-processing charge**, and they keep S3 traffic off the NAT Gateway — avoiding NAT data-processing fees for every S3 read/write.

- **Placement gap between the two VPC paths.** 
  - New-VPC path attaches the S3 endpoint to **both** `PRIVATE_WITH_EGRESS` and `PRIVATE_ISOLATED` subnets — correct, since the export Lambda and Glue job run in `PRIVATE_WITH_EGRESS`.
  - Existing-VPC path attaches it **only to `PRIVATE_ISOLATED`**. Any S3 traffic from workloads in the egress subnets there would fall back to the **NAT Gateway**, incurring data-processing charges.

  **Recommendation:** In the existing-VPC path, add `PRIVATE_WITH_EGRESS` to the S3 (and DynamoDB) gateway-endpoint subnet selection so both paths behave identically.

- **Limitations to keep in mind (no action needed, just awareness):** gateway endpoints only serve **same-region** S3 and only from **inside the VPC** (not on-prem/cross-region). All current S3 usage is same-region and in-VPC, so this is fine.

- **Cost upside is real for this workload.** Export writes/reads and Glue asset access route over the free gateway endpoint instead of the NAT path, so closing the placement gap is a small, pure cost win.

---

## 5. Cost Findings

| Item | Observation | Recommendation |
|------|-------------|----------------|
| Access-logs bucket retention | `ArtifactAccessLogs` has **no lifecycle rule** — server access logs accumulate indefinitely | Add a lifecycle rule (e.g. expire after 90 days, or transition to Glacier Instant Retrieval / Infrequent Access) |
| Export bucket lifecycle | 30-day expiration already set | Good — consider transitioning to Infrequent Access at ~7–14 days if exports are rarely re-downloaded |
| S3 traffic via NAT (existing-VPC path) | Egress-subnet S3 traffic bypasses the gateway endpoint | Fix endpoint subnet placement (§4) — removes NAT data-processing cost |
| Artifact bucket cleanup | `removalPolicy: DESTROY` without `autoDeleteObjects` on CICD buckets | Stack deletion will fail if buckets are non-empty; add `autoDeleteObjects: true` if you want clean teardown, or accept manual cleanup |
| SSE-KMS request cost (if adopted) | KMS adds per-request cost | Enable **S3 Bucket Keys** to cut KMS request volume dramatically |

---

## 6. Recommendations Summary

| # | Priority | Area | Recommendation |
|---|----------|------|----------------|
| 1 | Medium | Security | Add `enforceSSL: true` to the chat-exports bucket. |
| 2 | Medium/High | Security | Stop persisting presigned URLs in Postgres; generate them on demand with a short TTL behind the authenticated admin endpoint. |
| 3 | Low/Medium | Security | Evaluate SSE-KMS (CMK) + Bucket Keys for the exports bucket based on data classification. |
| 4 | Low | Cost/Best practice | Add `PRIVATE_WITH_EGRESS` to the S3 (and DynamoDB) gateway-endpoint subnet selection in the existing-VPC path. |
| 5 | Low | Cost | Add a lifecycle rule to the CICD `ArtifactAccessLogs` bucket. |
| 6 | Low | Hygiene | Verify the documented `generate-presigned-urls`/`data_sources/batch` upload endpoints still have a backing bucket + IAM; remove from docs/WAF if they're legacy. |
| 7 | Low | Hygiene | Consider `autoDeleteObjects: true` on CICD buckets for clean stack teardown. |

---

## 7. What I Did Not Change

This is a review only — no code or infrastructure was modified. Items 1, 4, and 5 are small, low-risk edits; items 2 and 3 involve a behavior change to the export download flow and should be weighed against how exports are actually consumed. Modifying bucket policies/encryption on buckets that already hold objects is medium-risk — apply through `cdk diff` → review → deploy, and note that switching encryption modes only affects newly written objects.
