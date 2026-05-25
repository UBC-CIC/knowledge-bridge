# Security Overview

**Project:** Specialization Explorer
**Document Type:** Public Security Architecture Overview
**Last Updated:** May 2026

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Security Architecture](#2-security-architecture)
3. [Authentication & Authorization](#3-authentication--authorization)
4. [API Security](#4-api-security)
5. [Network Security](#5-network-security)
6. [Data Protection](#6-data-protection)
7. [GenAI Security](#7-genai-security)
8. [Monitoring & Compliance](#8-monitoring--compliance)

---

## 1. Introduction

Specialization Explorer is an AI-powered conversational application that helps undergraduate students navigate academic specialization choices. This document provides an overview of the security measures implemented to protect user data, ensure system integrity, and maintain service availability.

### 1.1 Security Principles

| Principle | Description |
|-----------|-------------|
| **Defense in Depth** | Multiple layers of security controls |
| **Least Privilege** | Minimal permissions for all components |
| **Encryption Everywhere** | Data protected at rest and in transit |
| **Zero Trust** | Verify every request, trust nothing by default |
| **Privacy by Design** | PII protection built into the architecture |

---

## 2. Security Architecture

### 2.1 High-Level Architecture

```
╔═════════════════════════════════════════════════════════════════╗
║                          INTERNET                               ║
╚══════════════════════════════╤══════════════════════════════════╝
                               │
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║                      EDGE SECURITY LAYER                        ║
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │   CloudFront    │  │    AWS WAF      │  │  AWS Shield   │   ║
║   │   CDN + TLS     │  │   Firewall      │  │    DDoS       │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
╚══════════════════════════════╤══════════════════════════════════╝
                               │
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║                      APPLICATION LAYER                          ║
║                                                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │            API Gateway  (REST + WebSocket)              │   ║
║   │   Request validation · Rate limiting · Access logging   │   ║
║   └───────────────────────────┬─────────────────────────────┘   ║
║                               │                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │                  Lambda Authorizers                     │   ║
║   │   JWT validation · Role-based access · Session verify   │   ║
║   └───────────────────────────┬─────────────────────────────┘   ║
║                               │                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │               Lambda Functions  (VPC)                   │   ║
║   │   Input validation · Business logic · Param. queries    │   ║
║   └─────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════╤══════════════════════════════════╝
                               │
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║                         DATA LAYER                              ║
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │   RDS Proxy     │  │   PostgreSQL    │  │  S3 Bucket    │   ║
║   │     TLS         │  │   Encrypted     │  │  Encrypted    │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
╚══════════════════════════════╤══════════════════════════════════╝
                               │
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║                         AI / ML LAYER                           ║
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │    Bedrock      │  │ Knowledge Base  │  │  OpenSearch   │   ║
║   │   Guardrails    │  │     RAG         │  │  Serverless   │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
╚═════════════════════════════════════════════════════════════════╝
```

### 2.2 Security Layers Summary

| Layer | Components | Security Controls |
|-------|------------|-------------------|
| **Edge** | CloudFront, WAF, Shield | DDoS protection, TLS termination, rate limiting |
| **Application** | API Gateway, Lambda | Authentication, authorization, input validation |
| **Data** | RDS, S3, Secrets Manager | Encryption, access control, credential rotation |
| **AI/ML** | Bedrock, Knowledge Base | PII protection, prompt security, output validation |

---

## 3. Authentication & Authorization

### 3.1 Dual Authentication Model

```
╔═════════════════════════════════════════════════════════════════╗
║                     AUTHENTICATION FLOW                         ║
╠══════════════════════════════╦══════════════════════════════════╣
║        ADMIN USERS           ║          PUBLIC USERS            ║
║                              ║                                  ║
║   ┌──────────────────────┐   ║   ┌──────────────────────┐       ║
║   │     AWS Cognito      │   ║   │     Custom JWT       │       ║
║   │                      │   ║   │                      │       ║
║   │  · Email / password  │   ║   │  · Anonymous access  │       ║
║   │  · MFA support       │   ║   │  · Short-lived token │       ║
║   │  · Email verify      │   ║   │  · Auto-refresh      │       ║
║   │  · Group membership  │   ║   │                      │       ║
║   └──────────┬───────────┘   ║   └──────────┬───────────┘       ║
║              │               ║              │                   ║
║              ▼               ║              ▼                   ║
║   ┌──────────────────────┐   ║   ┌──────────────────────┐       ║
║   │   Admin Authorizer   │   ║   │   User Authorizer    │       ║
║   │    (Cognito JWT)     │   ║   │    (Custom JWT)      │       ║
║   └──────────────────────┘   ║   └──────────────────────┘       ║
╚══════════════════════════════╩══════════════════════════════════╝
```

### 3.2 Authorization Controls

| Control | Implementation |
|---------|----------------|
| **Role-Based Access** | Admin vs. user roles enforced at API and handler level |
| **Resource Ownership** | Users can only access their own sessions and data |
| **Session Validation** | UUID format validation and ownership verification |
| **Token Expiration** | Short-lived tokens with automatic refresh |

### 3.3 Password Policy

- Minimum 10 characters
- Requires uppercase, lowercase, digits, and symbols
- Account recovery via verified email only

---

## 4. API Security

### 4.1 Request Security Pipeline

```
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │   WAF    │───▶ │  Rate    │────▶│  Schema  │────▶│ Auth    │
  │  Rules   │     │  Limit   │     │  Valid.  │     │  Check   │
  └──────────┘     └──────────┘     └──────────┘     └──────────┘
       │                │                │                │
       ▼                ▼                ▼                ▼
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │  Block   │     │ Throttle │     │  Reject  │     │   Deny   │
  │ Attacks  │     │  Excess  │     │ Invalid  │     │  Unauth  │
  └──────────┘     └──────────┘     └──────────┘     └──────────┘
```

### 4.2 WAF Rules

| Rule Category | Protection |
|---------------|------------|
| **Managed Rules** | SQL injection, XSS, path traversal, and common attacks |
| **Rate Limiting** | IP-based limits with authentication awareness |
| **Endpoint Protection** | Stricter limits for expensive AI operations |

### 4.3 Request Validation

| Control | Detail |
|---------|--------|
| **OpenAPI Schema** | Request structure validated against specification |
| **Input Sanitization** | UUID format, length limits, enum validation |
| **Parameterized Queries** | SQL injection prevention at the database layer |

### 4.4 CORS Configuration

- Dynamic origin validation from configuration
- Restricted to known application domains
- Proper headers enforced on all error responses

---

## 5. Network Security

### 5.1 VPC Architecture

```
╔═════════════════════════════════════════════════════════════════╗
║                       VPC ARCHITECTURE                          ║
╠═════════════════════════════════════════════════════════════════╣
║                                                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │                    PUBLIC SUBNETS                       │   ║
║   │   · NAT Gateway  (outbound internet access)             │   ║
║   │   · Internet Gateway                                    │   ║
║   └───────────────────────────┬─────────────────────────────┘   ║
║                               │                                 ║
║                               ▼                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │                   PRIVATE SUBNETS                       │   ║
║   │   · Lambda functions  (VPC-connected)                   │   ║
║   │   · Outbound access via NAT                             │   ║
║   └───────────────────────────┬─────────────────────────────┘   ║
║                               │                                 ║
║                               ▼                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │                   ISOLATED SUBNETS                      │   ║
║   │   · RDS PostgreSQL  (no internet access)                │   ║
║   │   · RDS Proxy                                           │   ║
║   │   · VPC Endpoints  (AWS services)                       │   ║
║   └─────────────────────────────────────────────────────────┘   ║
╚═════════════════════════════════════════════════════════════════╝
```

### 5.2 Network Controls

| Control | Implementation |
|---------|----------------|
| **Subnet Isolation** | Database in isolated subnets with no internet route |
| **Security Groups** | Scoped ingress rules, VPC CIDR only |
| **VPC Endpoints** | Private connectivity to AWS services (no public internet) |
| **VPC Flow Logs** | Network traffic auditing |

### 5.3 Encryption in Transit

| Connection | Protocol |
|------------|----------|
| API Gateway | HTTPS / TLS 1.2+ (HTTP not accepted) |
| WebSocket | WSS |
| RDS Proxy → Database | TLS required |
| Lambda → AWS services | TLS via VPC endpoints |

---

## 6. Data Protection

### 6.1 Data Classification

| Data Type | Classification | Protection |
|-----------|----------------|------------|
| User credentials | Sensitive | Cognito managed, never stored in app |
| Chat messages | Private | Encrypted at rest, user-scoped access |
| Session data | Private | UUID-based, ownership validated |
| Knowledge base | Internal | Encrypted, admin-only upload |
| System config | Internal | Database stored, admin-only access |

### 6.2 Encryption at Rest

```
╔═════════════════════════════════════════════════════════════════╗
║                      ENCRYPTION AT REST                         ║
╠═════════════════════════════════════════════════════════════════╣
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │      RDS        │  │       S3        │  │  OpenSearch   │   ║
║   │    AES-256      │  │     SSE-S3      │  │ AWS-managed   │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
║                                                                 ║
╠═════════════════════════════════════════════════════════════════╣
║                      ENCRYPTION IN TRANSIT                      ║
╠═════════════════════════════════════════════════════════════════╣
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │   API Gateway   │  │   RDS Proxy     │  │   Bedrock     │   ║
║   │    TLS 1.2+     │  │  TLS Required   │  │     TLS       │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
║                                                                 ║
╚═════════════════════════════════════════════════════════════════╝
```

> All encrypted resources currently use AWS managed keys. For details on which resources are affected and how to switch to customer-managed KMS keys, see [`Docs/AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md).

### 6.3 Credential Management

| Credential | Storage | Rotation |
|------------|---------|----------|
| Database credentials (admin) | AWS Secrets Manager | 30-day automatic |
| Database credentials (app users) | AWS Secrets Manager | 30-day automatic |
| JWT signing key | AWS Secrets Manager | Manual |
| Cognito secrets | AWS Secrets Manager | N/A (static IDs) |

### 6.4 S3 Bucket Security

| Control | Detail |
|---------|--------|
| **Block Public Access** | Enabled on all buckets |
| **SSL Required** | All requests must use HTTPS |
| **Presigned URLs** | Short expiration for uploads |
| **Content-Type Validation** | Enforced for uploaded files |

---

## 7. GenAI Security

### 7.1 AI Security Pipeline

```
  USER INPUT
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  1 · INPUT VALIDATION                                       │
  │      · Length limits (2 000 characters)                     │
  │      · Format validation                                    │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  2 · BEDROCK GUARDRAILS                                     │
  │      · PII Detection & Anonymization                        │
  │      · Prompt Attack Detection                              │
  │     ✗  Blocked → return denial  (no LLM call made)          │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  3 · RAG RETRIEVAL                                          │
  │      · Knowledge Base query                                 │
  │      · Source document retrieval                            │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  4 · LLM GENERATION                                         │
  │      · Grounded in retrieved context                        │
  │      · System prompts enforce topic scope                   │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  5 · OUTPUT VALIDATION                                      │
  │      · Hallucination detection                              │
  │      · Source grounding verification                        │
  │      · Warning injected if response is ungrounded           │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  RESPONSE TO USER
```

### 7.2 PII Protection

| Category | Protected Data Types |
|----------|---------------------|
| **Contact** | Email, phone, address |
| **Identity** | Name, age, username |
| **Financial** | Credit card numbers, bank accounts |
| **Government** | Social insurance numbers, health numbers |
| **Technical** | IP addresses, URLs |

### 7.3 Prompt Security

| Control | Description |
|---------|-------------|
| **Prompt Attack Detection** | Identifies and blocks injection attempts |
| **Scope Enforcement** | System prompts restrict topic to academic advising |
| **Guardrails** | Strict boundaries on acceptable responses |

For guardrail configuration details, see [`Docs/BEDROCK_GUARDRAILS.md`](./BEDROCK_GUARDRAILS.md).

### 7.4 Output Validation

| Control | Description |
|---------|-------------|
| **Grounding Verification** | Responses checked against source documents |
| **Hallucination Detection** | LLM-based verification of claims |
| **Warning System** | Users notified when responses may be ungrounded |

---

## 8. Monitoring & Compliance

### 8.1 Logging Architecture

```
  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
  │   API Gateway   │   │     Lambda      │   │   VPC Flow      │
  │   Access Logs   │   │      Logs       │   │     Logs        │
  └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
           │                     │                     │
           └─────────────────────┼─────────────────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │  CloudWatch Logs      │
                     │  & Metrics            │
                     └───────────┬───────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │  CloudWatch Alarms    │
                     │  (concurrency, errors,│
                     │   WAF block rate)     │
                     └───────────────────────┘
```

### 8.2 Security Logging

| Log Type | Content | Retention |
|----------|---------|-----------|
| **API Access Logs** | Request metadata, status codes, latency | 1 week |
| **Lambda Logs** | Function execution, errors (body excluded) | 1 week |
| **VPC Flow Logs** | Network traffic metadata | Configurable |
| **WebSocket Logs** | Connection events, route keys | 1 week |

### 8.3 Alerting

| Alert | Trigger | Purpose |
|-------|---------|---------|
| **Concurrency Alarm** | Lambda approaching reserved limit | Prevent service degradation |
| **Error Rate Alarm** | Elevated 5XX responses | Detect service issues |
| **WAF Block Alarm** | High block rate | Detect attack patterns |

### 8.4 Compliance Summary

| Control Area | Status | Notes |
|--------------|--------|-------|
| **Encryption at Rest** | ✅ Enabled | AWS managed keys (CMK upgrade available — see [`AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md)) |
| **Encryption in Transit** | ✅ Enabled | TLS enforced on all connections |
| **Access Control** | ✅ Enabled | Role-based, least privilege |
| **Audit Logging** | ✅ Enabled | Comprehensive logging across all layers |
| **Credential Management** | ✅ Enabled | Secrets Manager with automatic rotation |
| **PII Protection** | ✅ Enabled | Automatic anonymization via Bedrock Guardrails |
| **Input Validation** | ✅ Enabled | Schema and application-level validation |
| **Rate Limiting** | ✅ Enabled | Multi-layer WAF and API Gateway throttling |

---

## 9. Security Contact

For security concerns or to report vulnerabilities, please contact the project maintainers through the repository's security policy.

---

*This document provides a high-level overview of security controls. Implementation details are maintained in internal documentation.*
