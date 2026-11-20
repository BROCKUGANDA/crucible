# API Contracts

## Overview

Crucible API follows RESTful conventions with JSON request/response bodies. All endpoints return consistent response envelopes.

## Response Envelope

```json
{
  "data": {},
  "error": null,
  "meta": {
    "requestId": "uuid",
    "timestamp": 1234567890
  }
}
```

## Authentication

### SIWE (Sign-In with Ethereum)
- `POST /api/auth/siwe/challenge` — Get sign-in challenge
- `POST /api/auth/siwe/verify` — Verify signed message
- Returns JWT session token

### API Keys
- Header: `Authorization: Bearer <api_key>`
- Scoped to tenant and permissions

## Rate Limiting

Headers included in every response:
- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Window reset timestamp

## Pagination

All list endpoints support key-based pagination:
- `?limit=20` — Number of items (default: 20, max: 100)
- `?after=cursor` — Pagination cursor from previous response

Response includes:
```json
{
  "data": [],
  "pagination": {
    "nextCursor": "base64cursor",
    "hasMore": true
  }
}
```

## Core Endpoints

### Agents
- `GET /api/agents` — List agents
- `GET /api/agents/:id` — Get agent details
- `POST /api/agents` — Register agent (auth required)

### Trials
- `GET /api/trials` — List trials
- `GET /api/trials/:id` — Get trial details
- `POST /api/trials` — Create trial (auth required)

### Suites
- `GET /api/suites` — List benchmark suites
- `GET /api/suites/:id` — Get suite details
- `GET /api/suites/:id/versions` — Get suite versions
- `POST /api/suites` — Create suite (auth required)

### Scoring
- `GET /api/rubrics` — List rubrics
- `POST /api/rubrics` — Create rubric (auth required)
- `POST /api/scores/dimension` — Create dimension score
- `POST /api/scores/aggregate` — Compute aggregate score

### Sponsors
- `POST /api/sponsors` — Register sponsor
- `GET /api/sponsors/:id` — Get sponsor details
- `POST /api/sponsors/:id/programs` — Create program
- `GET /api/programs/:id` — Get program details

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request — Invalid input |
| 401 | Unauthorized — Missing or invalid auth |
| 403 | Forbidden — Insufficient permissions |
| 404 | Not Found — Resource not found |
| 409 | Conflict — Duplicate resource |
| 422 | Unprocessable — Validation failed |
| 429 | Too Many Requests — Rate limited |
| 500 | Internal Server Error |

## Webhooks

- Signed with HMAC-SHA256
- Signature in `X-Webhook-Signature` header
- Retry policy: 3 attempts with exponential backoff

## Versioning

API version in URL path: `/api/v1/...`
Breaking changes require new major version.
