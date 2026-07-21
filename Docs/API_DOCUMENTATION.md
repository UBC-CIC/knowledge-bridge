# KBA REST API Documentation

This document provides comprehensive documentation for the KBA REST API, including endpoint descriptions, authentication requirements, request/response formats, and example usage.

## Table of Contents

- [Authentication](#authentication)
- [Base URL](#base-url)
- [Common Headers](#common-headers)
- [Error Responses](#error-responses)
- [User Endpoints](#user-endpoints)
- [Chat Session Endpoints](#chat-session-endpoints)
- [System Message Endpoints](#system-message-endpoints)
- [Admin Endpoints](#admin-endpoints)
  - [User Management](#user-management)
  - [Entra Groups](#entra-groups)
  - [Ingestion](#ingestion)
  - [Export](#export)
  - [Notifications](#notifications)
  - [Feedback](#feedback)
  - [System Settings](#system-settings)
  - [System Messages](#system-messages)
  - [Analytics](#analytics)

## Authentication

All API endpoints require authentication using AWS Cognito JWT tokens passed in the `Authorization` header.

---

### Obtaining a Token

Users authenticate through AWS Cognito and receive an ID token used for all API requests.

```javascript
// JavaScript example using AWS Amplify
import { fetchAuthSession } from "aws-amplify/auth";

const session = await fetchAuthSession();
const token = session.tokens?.idToken?.toString();
```

---

### Authorization Levels

The API uses two custom Lambda authorizers:

- **adminAuthorizer**: Validates the user has admin privileges. Required for all `/admin/*` endpoints.
- **userAuthorizer**: Validates any authenticated user. Required for user, chat session, and system message endpoints.

## Base URL

```
https://{api-id}.execute-api.{region}.amazonaws.com/prod
```

Replace `{api-id}` and `{region}` with your API Gateway deployment values (found in the AWS Console or CDK outputs).

## Common Headers

```
Authorization: {cognito-id-token}
Content-Type: application/json
```

## Error Responses

### Standard Error Format

```json
{ "error": "Error message description" }
```

### HTTP Status Codes

- `200` - Success
- `201` - Created
- `202` - Accepted
- `204` - No Content
- `400` - Bad Request
- `401` - Unauthorized (missing or invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `409` - Conflict (e.g. no running job to stop)
- `500` - Internal Server Error

---

# User Endpoints

These endpoints require a valid Cognito token (`userAuthorizer`).

## Get User

Retrieve a user by ID.

**Endpoint:** `GET /user/{user_id}`

**Path Parameters:**

- `user_id` (uuid, required): The user's UUID

**Response:** `200 OK` with user object

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Update User Email

Update a user's email address.

**Endpoint:** `PUT /user/{user_id}`

**Path Parameters:**

- `user_id` (uuid, required): The user's UUID

**Request Body:**

```json
{ "email": "newemail@example.com" }
```

**Parameters:**

- `email` (string, required): New email address

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"email": "newemail@example.com"}'
```

---

## Get Accessible Sources

Get SharePoint lists accessible to a user based on their Entra group memberships.

**Endpoint:** `GET /user/{user_id}/accessible_sources`

**Path Parameters:**

- `user_id` (uuid, required): The user's UUID

**Response:** `200 OK` with list of accessible site sources

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid/accessible_sources" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Get Chat History

Get paginated message history for a chat session owned by a user.

**Endpoint:** `GET /user/{user_id}/chat_sessions/{chat_session_id}/chat_history`

**Path Parameters:**

- `user_id` (uuid, required): Owner's UUID
- `chat_session_id` (uuid, required): Chat session UUID

**Query Parameters:**

- `limit` (integer, optional): Messages to return, max 1000 (default: 200)
- `offset` (integer, optional): Messages to skip (default: 0)

**Response:**

```json
{
  "chat_session_id": "uuid",
  "user_id": "uuid",
  "messages": [
    {
      "id": "uuid",
      "chat_session_id": "uuid",
      "sender": "user",
      "content": "What programs are available?",
      "sources": null,
      "warning": null,
      "created_at": "2024-01-20T14:22:00.000Z"
    }
  ],
  "pagination": {
    "limit": 200,
    "offset": 0,
    "total": 42,
    "hasMore": false
  }
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid/chat_sessions/uuid/chat_history?limit=50&offset=0" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Rate AI Message

Rate an AI message with a thumbs up or down. For thumbs down, a category and optional comment can be included.

**Endpoint:** `POST /user/{user_id}/chat_sessions/{chat_session_id}/messages/{message_id}/rating`

**Path Parameters:**

- `user_id` (uuid, required): Owner's UUID
- `chat_session_id` (uuid, required): Chat session UUID
- `message_id` (uuid, required): Message UUID to rate

**Request Body:**

```json
{
  "is_positive": false,
  "category": "Inaccurate",
  "comment": "The answer was incorrect about program requirements."
}
```

**Parameters:**

- `is_positive` (boolean, required): `true` for thumbs up, `false` for thumbs down
- `category` (string, optional): One of `Not helpful`, `Inaccurate`, `Off-topic`, `Other` — only for thumbs down
- `comment` (string, optional): Free-text comment, max 2000 chars

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid/chat_sessions/uuid/messages/uuid/rating" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"is_positive": false, "category": "Inaccurate"}'
```

---

# Chat Session Endpoints

These endpoints require a valid Cognito token (`userAuthorizer`).

## Create Chat Session

Create a new chat session for a user.

**Endpoint:** `POST /chat_sessions`

**Request Body (optional):**

```json
{
  "title": "My first chat",
  "metadata": {}
}
```

**Parameters:**

- `title` (string, optional): Chat session title
- `metadata` (object, optional): Arbitrary metadata

**Response:** `201 Created`

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "title": "My first chat",
  "created_at": "2024-01-15T10:30:00.000Z",
  "last_active_at": "2024-01-15T10:30:00.000Z",
  "metadata": null
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "My first chat"}'
```

---

## Get Chat Sessions for User

Get all chat sessions belonging to a user.

**Endpoint:** `GET /chat_sessions/user/{user_id}`

**Path Parameters:**

- `user_id` (uuid, required): User UUID

**Response:** `200 OK` with list of chat session objects

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/user/uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Rename Chat Session

Rename a chat session. Only the owning user may update.

**Endpoint:** `PUT /chat_sessions/{chat_session_id}`

**Path Parameters:**

- `chat_session_id` (uuid, required): Chat session UUID

**Request Body:**

```json
{ "title": "Renamed session" }
```

**Parameters:**

- `title` (string, required): New title (min length 1)

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Renamed session"}'
```

---

## Delete Chat Session

Delete a chat session. Only the owning user may delete.

**Endpoint:** `DELETE /chat_sessions/{chat_session_id}`

**Path Parameters:**

- `chat_session_id` (uuid, required): Chat session UUID

**Response:** `204 No Content`

**Example (cURL):**

```bash
curl -X DELETE "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Generate Text Response

Generate an AI response for a message in a chat session.

**Endpoint:** `POST /chat_sessions/{chat_session_id}/text_generation`

**Path Parameters:**

- `chat_session_id` (uuid, required): Chat session UUID

**Request Body:**

```json
{
  "query": "What are the eligibility requirements for the CIO program?",
  "user_id": "uuid"
}
```

**Parameters:**

- `query` (string, required): The user's message
- `user_id` (uuid, optional): User UUID

**Response:**

```json
{
  "response": "The eligibility requirements are...",
  "sources": []
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/uuid/text_generation" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"query": "What are the eligibility requirements?", "user_id": "uuid"}'
```

---

# System Message Endpoints

These endpoints require a valid Cognito token (`userAuthorizer`).

## Get Active System Message

Get the currently active version of a system message by type.

**Endpoint:** `GET /system_message/{message_type}`

**Path Parameters:**

- `message_type` (string, required): One of:
  - `disclaimer`, `guardrails`, `system_role`, `system_checklist`, `system_instructions`
  - `initial_prompt`, `detective_phase_prompt`, `suggestion_phase_prompt`
  - `welcome_message`

**Response:**

```json
{
  "id": "uuid",
  "type": "disclaimer",
  "message": "AI can make mistakes. Check important info.",
  "version": 2,
  "created_at": "2024-01-15T10:30:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/system_message/disclaimer" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Get Max Characters Per User Message

Get the currently configured maximum character limit for user messages.

**Endpoint:** `GET /system-settings/max-characters-per-user-message`

**Response:**

```json
{ "max_characters_per_user_message": 2000 }
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/system-settings/max-characters-per-user-message" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

# Admin Endpoints

All admin endpoints require a valid Cognito token with admin privileges (`adminAuthorizer`).

## User Management

### List Users

Get a paginated list of all users.

**Endpoint:** `GET /admin/users`

**Query Parameters:**

- `limit` (integer, optional): Number of users to return (default: 50)
- `offset` (integer, optional): Number of users to skip (default: 0)

**Response:** `200 OK` with list of user objects

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/users?limit=50&offset=0" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Admin User

Create a new admin user.

**Endpoint:** `POST /admin/users`

**Request Body:**

```json
{
  "display_name": "Jane Smith",
  "email": "jane.smith@example.com",
  "institution_id": "ubc"
}
```

**Parameters:**

- `display_name` (string, required): Display name (max 255 chars)
- `email` (string, required): Email address (max 255 chars)
- `institution_id` (string, optional): Institution identifier (max 255 chars)

**Response:** `201 Created`

```json
{
  "id": "uuid",
  "display_name": "Jane Smith",
  "email": "jane.smith@example.com",
  "institution_id": "ubc",
  "created_at": "2024-01-15T10:30:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/users" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"display_name": "Jane Smith", "email": "jane.smith@example.com"}'
```

---

### Update User Email

Update an existing user's email address.

**Endpoint:** `POST /admin/promote_user`

**Request Body:**

```json
{
  "user_id": "uuid",
  "email": "user@example.com"
}
```

**Parameters:**

- `user_id` (string, required): UUID of the user to update
- `email` (string, required): Updated email address

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/promote_user" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"user_id": "uuid", "email": "user@example.com"}'
```

---

### Get User Chat Sessions

Get all chat sessions for a specific user.

**Endpoint:** `GET /admin/users/{userId}/chat_sessions`

**Path Parameters:**

- `userId` (uuid, required): The user's UUID

**Query Parameters:**

- `limit` (integer, optional): Default 50
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with list of chat session objects

---

### Get Chat Session Messages

Get all messages for a specific chat session.

**Endpoint:** `GET /admin/chat_sessions/{sessionId}/messages`

**Path Parameters:**

- `sessionId` (uuid, required): Chat session UUID

**Query Parameters:**

- `limit` (integer, optional): Default 200
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with list of message objects

---

## Entra Groups

### List Entra Groups

Get a paginated list of Entra groups with member counts.

**Endpoint:** `GET /admin/entra_groups`

**Query Parameters:**

- `limit` (integer, optional): Default 20
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with paginated list of Entra groups

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/entra_groups?limit=20&offset=0" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Users in Entra Group

Get paginated users within a specific Entra group.

**Endpoint:** `GET /admin/entra_groups/{groupId}/users`

**Path Parameters:**

- `groupId` (string, required): Entra group ID

**Query Parameters:**

- `limit` (integer, optional): Default 10
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with paginated list of users in the group

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/entra_groups/group-id/users" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Unassigned Users

Get users with no Entra group memberships.

**Endpoint:** `GET /admin/entra_groups/unassigned/users`

**Query Parameters:**

- `limit` (integer, optional): Default 10
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with paginated list of unassigned users

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/entra_groups/unassigned/users" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Ingestion

### Trigger Ingestion

Trigger a SharePoint ingestion Glue job run.

**Endpoint:** `POST /admin/ingestion/trigger`

**Request Body (optional):**

```json
{ "force_full": false }
```

**Parameters:**

- `force_full` (boolean, optional): Force a full re-ingestion instead of incremental (default: `false`)

**Response:** `200 OK` — job started

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/ingestion/trigger" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"force_full": false}'
```

---

### Stop Ingestion

Stop the currently running ingestion Glue job.

**Endpoint:** `POST /admin/ingestion/stop`

**Response:**

- `200 OK` — stop requested
- `409 Conflict` — no running job to stop

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/ingestion/stop" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### List Ingestion Runs

List recent site-level ingestion runs from the database.

**Endpoint:** `GET /admin/ingestion/runs`

**Query Parameters:**

- `limit` (integer, optional): Number of runs to return (default: 5, max: 50)
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with list of ingestion run objects

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/ingestion/runs?limit=10" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Ingestion Logs

Get logs for a Glue job run (streamed from CloudWatch).

**Endpoint:** `GET /admin/ingestion/logs`

**Query Parameters:**

- `jobRunId` (string, required): Glue job run ID
- `nextToken` (string, optional): Pagination token from a previous response
- `logType` (string, optional): `output` or `error` (default: `output`)

**Response:** `200 OK` with log lines and a pagination token

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/ingestion/logs?jobRunId=jr_abc123" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Ingestion Schedule

Get the current EventBridge ingestion schedule.

**Endpoint:** `GET /admin/ingestion/schedule`

**Response:** `200 OK` — schedule config, or `{ "exists": false }` if no schedule is set

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/ingestion/schedule" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create or Update Ingestion Schedule

Create or update the EventBridge ingestion schedule.

**Endpoint:** `PUT /admin/ingestion/schedule`

**Request Body:**

```json
{
  "cron": "0 2 * * ? *",
  "timezone": "America/Vancouver",
  "enabled": true,
  "force_full": false
}
```

**Parameters:**

- `cron` (string, required): Cron expression for the schedule
- `timezone` (string, required): IANA timezone string
- `enabled` (boolean, optional): Whether the schedule is active (default: `true`)
- `force_full` (boolean, optional): Force full re-ingestion on each scheduled run (default: `false`)

**Response:** `200 OK` — schedule created or updated

**Example (cURL):**

```bash
curl -X PUT "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/ingestion/schedule" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"cron": "0 2 * * ? *", "timezone": "America/Vancouver"}'
```

---

### Delete Ingestion Schedule

Delete the EventBridge ingestion schedule.

**Endpoint:** `DELETE /admin/ingestion/schedule`

**Response:**

- `200 OK` — schedule deleted
- `404 Not Found` — no schedule exists

**Example (cURL):**

```bash
curl -X DELETE "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/ingestion/schedule" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Export

### Trigger Export

Trigger a new chat export job.

**Endpoint:** `POST /admin/export/trigger`

**Request Body:**

```json
{
  "scope": "group",
  "scope_id": "uuid"
}
```

**Parameters:**

- `scope` (string, required): `all`, `group`, `user`, or `analytics`
- `scope_id` (uuid, optional): Required when `scope` is `group` or `user`
- `groupId` (string, optional): Entra group ID filter — used when `scope` is `analytics`
- `timeRange` (string, optional): Time range filter — used when `scope` is `analytics`

**Response:** `202 Accepted`

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/export/trigger" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"scope": "all"}'
```

---

### List Export Runs

List export job runs for the current admin.

**Endpoint:** `GET /admin/export/runs`

**Query Parameters:**

- `offset` (integer, optional): Default 0
- `export_type` (string, optional): Filter by type — `chat` or `analytics`

**Response:** `200 OK` with paginated list of export runs

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/export/runs" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Notifications

### List Notifications

List notifications for the current admin.

**Endpoint:** `GET /admin/notifications`

**Response:** `200 OK` with notifications list and total count

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/notifications" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Clear All Notifications

Clear all notifications for the current admin.

**Endpoint:** `DELETE /admin/notifications`

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X DELETE "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/notifications" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Dismiss Notification

Dismiss a single notification by ID.

**Endpoint:** `DELETE /admin/notifications/{notification_id}`

**Path Parameters:**

- `notification_id` (string, required): Notification ID

**Response:**

- `200 OK` — notification dismissed
- `404 Not Found` — notification not found

**Example (cURL):**

```bash
curl -X DELETE "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/notifications/notif-id" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Feedback

### List Feedback

List dislike feedback entries with message context.

**Endpoint:** `GET /admin/feedback`

**Query Parameters:**

- `from` (ISO datetime, optional): Return only feedback at or after this timestamp
- `to` (ISO datetime, optional): Return only feedback at or before this timestamp
- `category` (string, optional): Filter by category — one of `Not helpful`, `Inaccurate`, `Off-topic`, `Other`
- `limit` (integer, optional): Default 50
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with paginated feedback list

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/feedback?limit=50" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get Feedback Summary

Get daily dislike trend and per-category counts.

**Endpoint:** `GET /admin/feedback/summary`

**Query Parameters:**

- `from` (ISO datetime, optional): Include data at or after this timestamp
- `to` (ISO datetime, optional): Include data at or before this timestamp

**Response:** `200 OK` with trend data and category counts

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/feedback/summary" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## System Settings

### Get System Settings

Retrieve the latest system configuration settings.

**Endpoint:** `GET /admin/system-settings`

**Response:**

```json
{
  "id": "uuid",
  "max_messages_per_day": 45,
  "max_characters_per_user_message": 2000,
  "max_characters_per_ai_message": 5000,
  "temperature": 0.2,
  "support_score_threshold": 0.25,
  "scope_alignment_score_threshold": 0.25,
  "grounded_threshold": 0.75,
  "partially_grounded_threshold": 0.5,
  "max_context_chunks": 10,
  "max_history_messages": 20,
  "updated_by_email": null,
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-settings" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update System Settings

Update one or more system configuration settings (partial update).

**Endpoint:** `PUT /admin/system-settings`

**Request Body:**

```json
{
  "max_messages_per_day": 50,
  "temperature": 0.8,
  "top_p": 0.95
}
```

**Parameters (all optional):**

- `max_messages_per_day` (integer, 1–1000): Max messages per user per day
- `max_characters_per_user_message` (integer, 1–200000): Max user message length
- `max_characters_per_ai_message` (integer, 1–200000): Max AI response length
- `temperature` (number, 0–2): LLM temperature
- `support_score_threshold` (number, 0–1): Threshold for support scoring
- `scope_alignment_score_threshold` (number, 0–1): Threshold for scope alignment
- `grounded_threshold` (number, 0–1): Threshold for grounded responses
- `partially_grounded_threshold` (number, 0–1): Threshold for partially grounded responses
- `max_context_chunks` (integer, 1–50): Max RAG chunks included in context
- `max_history_messages` (integer, 1–100): Max chat history messages passed to LLM

**Response:** `200 OK` with updated settings object

**Example (cURL):**

```bash
curl -X PUT "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-settings" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"max_messages_per_day": 50, "temperature": 0.8}'
```

---

## System Messages

### Get All System Messages

Get all system message types with their full version history. Active version is listed first.

**Endpoint:** `GET /admin/system-messages`

**Response:**

```json
{
  "disclaimer": [
    {
      "id": "uuid",
      "type": "disclaimer",
      "content": "AI can make mistakes. Check important info.",
      "character_limit": 400,
      "version": 2,
      "is_active": true,
      "affects_text_generation": false,
      "created_by": "uuid",
      "created_by_email": "admin@example.com",
      "created_at": "2024-01-15T10:30:00.000Z"
    }
  ],
  "welcome_message": [...]
}
```

**System message types:**

| Type | Description |
|---|---|
| `disclaimer` | Disclaimer shown to users |
| `guardrails` | Content guardrail instructions |
| `system_role` | AI system role definition |
| `system_checklist` | AI checklist instructions |
| `system_instructions` | General AI instructions |
| `initial_prompt` | Initial conversation prompt |
| `detective_phase_prompt` | Detective phase AI prompt |
| `suggestion_phase_prompt` | Suggestion phase AI prompt |
| `welcome_message` | Welcome message shown on chat |
| `partial_hallucination_warning` | Warning for partial hallucinations |
| `full_hallucination_warning` | Warning for full hallucinations |

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create System Message Version

Create a new version of a system message and set it as active.

**Endpoint:** `POST /admin/system-messages/{system_message_type}`

**Path Parameters:**

- `system_message_type` (string, required): One of the types listed in the table above

**Request Body:**

```json
{
  "content": "AI can make mistakes. Always verify important information."
}
```

**Parameters:**

- `content` (string, required): The full message content

**Response:** `200 OK` with the newly created version object (`is_active: true`)

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages/disclaimer" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"content": "AI can make mistakes."}'
```

---

### Activate System Message Version

Set a specific version as the active version for its type.

**Endpoint:** `POST /admin/system-messages/{system_message_type}/{version_id}/activate`

**Path Parameters:**

- `system_message_type` (string, required): Message type
- `version_id` (uuid, required): UUID of the version to activate

**Response:**

```json
{
  "success": true,
  "status": "activated",
  "activated": { "id": "uuid", "type": "disclaimer", "version": 2, "is_active": true },
  "previous_active": { "id": "uuid", "version": 1 }
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages/disclaimer/uuid/activate" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete System Message Version

Delete a non-active system message version. Active versions cannot be deleted.

**Endpoint:** `DELETE /admin/system-messages/{system_message_type}/{version_id}`

**Path Parameters:**

- `system_message_type` (string, required): Message type
- `version_id` (uuid, required): UUID of the version to delete

**Response:**

```json
{
  "success": true,
  "deleted": { "id": "uuid", "type": "disclaimer", "version": 1 }
}
```

**Example (cURL):**

```bash
curl -X DELETE "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages/disclaimer/uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Analytics

### Get Analytics

Get usage analytics time series and totals.

**Endpoint:** `GET /admin/analytics`

**Query Parameters:**

- `timeRange` (string, optional): Time range — `7d`, `30d`, `90d`, `6m`, `1y`, `all` (default: `90d`)
- `groupId` (string, optional): Entra group ID to filter by. Omit or pass `all` for all groups.

**Response:**

```json
{
  "totals": {
    "users": 120,
    "chat_sessions": 450,
    "messages": 3200,
    "questions": 1800
  },
  "timeSeries": [
    {
      "date": "2024-01-20",
      "users": 12,
      "questions": 45,
      "chat_sessions": 18
    }
  ]
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/analytics?timeRange=30d" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Security Considerations

### Token Management

- Cognito ID tokens expire after 1 hour — use refresh tokens to obtain new ones
- Never expose tokens in logs or client-side code
- Use AWS Amplify for automatic secure token storage and refresh

### CORS

All endpoints support CORS with the following headers:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: *`
- `Access-Control-Allow-Headers: Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token`

### Input Validation

- Request bodies are validated against schemas defined in the OpenAPI spec
- Query parameters are type-checked
- The raw OpenAPI/Swagger definition is located at `cdk/OpenAPI_Swagger_Definition.yaml`

## WebSocket API

For real-time streaming AI responses, use the WebSocket API instead of the REST text generation endpoint.

**WebSocket URL:**

```
wss://{websocket-api-id}.execute-api.{region}.amazonaws.com/prod
```

The WebSocket URL is available as a CDK output after deployment.

## Troubleshooting

### 401 Unauthorized

- Verify the `Authorization` header is present and contains a valid Cognito ID token
- Check the token hasn't expired (1 hour lifetime)

```javascript
import { fetchAuthSession } from "aws-amplify/auth";
const session = await fetchAuthSession({ forceRefresh: true });
const token = session.tokens?.idToken?.toString();
```

### 403 Forbidden

- Verify the user has the required role (`admin` for `/admin/*` endpoints)
- Admin and user authorizers are separate — having an admin account does not automatically grant user-level access if the user record doesn't exist

### 404 Not Found

- Verify the resource ID is correct
- Check the user owns the resource (for user-scoped endpoints)

### 409 Conflict

- For `POST /admin/ingestion/stop`: no job is currently running
- A resource with the same identifier already exists (e.g. duplicate email on user creation)

### 500 Internal Server Error

- Check CloudWatch logs for the relevant Lambda function for detailed error information
- Verify the request body matches the expected schema

---

## Internal / Dev Endpoints

### Example Endpoint

Test/scaffold endpoint for verifying user Lambda connectivity. Not intended for production use.

**Endpoint:** `GET /user/exampleEndpoint`

**Response:** `200 OK` — `"Example endpoint invoked"`

---

**API Version:** 1.0.0  
**OpenAPI Spec:** `cdk/OpenAPI_Swagger_Definition.yaml`
