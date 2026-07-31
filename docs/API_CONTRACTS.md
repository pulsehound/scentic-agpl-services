# Scentic ↔ AGPL Gateway REST API Contracts

**Status:** AGPL-00 planning document — not yet implemented.
**Scope:** Defines the stable REST API surface between the proprietary Scentic core and the AGPL-licensed `scentic-agpl-services` gateway.
**Audience:** Scentic core integration engineers, gateway implementers, security reviewers, release-gatekeeper.

---

## 1. Transport and base URL

- **Scheme:** `https` only in staging/production. `http` permitted only on `localhost` for local development.
- **Base URL:** `http(s)://<gateway-host>:<GATEWAY_PORT>` (default port `3101`, see `GATEWAY_PORT` env).
- **Content type:** `application/json; charset=utf-8` for all request and response bodies.
- **Body encoding:** UTF-8. Binary PDFs are never sent inline; they are referenced by a gateway-side temporary URL or returned as `application/pdf` on download endpoints.
- **API versioning:** All routes are prefixed with an implicit `v1`. Future incompatible changes must use a `v2` prefix. Additive field additions within `v1` are allowed and must be ignored by older clients.

## 2. Cross-cutting headers

### 2.1 Required on every request

| Header | Required | Purpose |
|--------|----------|---------|
| `X-Scentic-Service-Token` | Yes (all routes except `GET /health` and `GET /source-offer`) | Service-to-service auth. Constant-time compared against `SCENTIC_SERVICE_TOKEN`. |
| `X-Correlation-Id` | Optional on request; **always** present on response | End-to-end trace id. If absent on request, gateway generates a UUIDv4 and echoes it on the response. |
| `User-Agent` | Recommended | Should identify Scentic core version, e.g. `scentic-core/1.2.3`. |

### 2.2 Required on requests with side effects

Applies to all `POST`, `PUT`, `PATCH`, `DELETE` routes except `POST /health` probes (none defined).

| Header | Required | Purpose |
|--------|----------|---------|
| `X-Idempotency-Key` | Yes | Client-generated UUIDv4. Gateway stores `(key, route, status, response)` for 24h. A replay with the same key returns the original response (see §4). |

### 2.3 Always present on responses

| Header | Always present | Purpose |
|--------|----------------|---------|
| `X-Correlation-Id` | Yes | Echoes request id or generated id. |
| `X-Gateway-Version` | Yes | Gateway semver, e.g. `0.1.0`. |
| `X-Request-Duration-Ms` | Yes | Server-side wall-clock handling time. |

## 3. Common response envelope

All JSON responses (success and error) use the same envelope:

```json
{
  "ok": true,
  "correlationId": "5f3e2b1a-...",
  "data": { ... },
  "meta": {
    "gatewayVersion": "0.1.0",
    "page": { "cursor": "eyJpZCI6MTIz...", "limit": 50, "hasMore": true },
    "upstream": {
      "provider": "kimai",
      "providerDurationMs": 87,
      "providerCorrelationId": "..."
    }
  }
}
```

Error envelope:

```json
{
  "ok": false,
  "correlationId": "5f3e2b1a-...",
  "error": {
    "code": "INVALID_INPUT",
    "message": "firmId must be a UUID",
    "details": [
      { "field": "firmId", "issue": "not a UUID" }
    ],
    "retryable": false,
    "upstream": null
  },
  "meta": { "gatewayVersion": "0.1.0" }
}
```

`ok` is `true` only when HTTP status is 2xx. `error.retryable` indicates whether a client retry with the same idempotency key is safe. Pagination uses opaque cursor tokens; never decode or construct them client-side.

## 4. Idempotency rules

1. The idempotency cache key is `hash(X-Idempotency-Key || method || path-without-query)`.
2. On a cache hit, the gateway returns the **exact same status, body, and headers** as the original response, without re-executing side effects. The response includes the header `X-Idempotent-Replay: true`.
3. On a cache miss the request executes normally and the result is stored.
4. If the same key is reused with a **different body**, the gateway returns `409 CONFLICT` with code `IDEMPOTENCY_KEY_REUSE` and does not execute. This prevents accidental aliasing.
5. Cache retention is 24 hours. After expiry the same key may be reused; clients must generate fresh UUIDs per logical operation.
6. Only responses with HTTP status < 500 are cached. 5xx responses are not cached so that retries execute fresh.
7. `GET`, `HEAD`, `OPTIONS` are inherently idempotent and do not require `X-Idempotency-Key`. If supplied on a `GET`, it is ignored.
8. Idempotency is per-gateway-instance. In a multi-instance deployment the cache is backed by Redis (or equivalent) shared across instances. Single-instance deployments use an in-process LRU.

## 5. Auth model

- All routes (except `GET /health` and `GET /source-offer`) require a valid `X-Scentic-Service-Token`.
- The token is compared in constant time against the configured `SCENTIC_SERVICE_TOKEN`. A failed comparison returns `401 UNAUTHORIZED` with code `INVALID_SERVICE_TOKEN` and increments a metric; it must not leak whether the token is malformed vs absent.
- The token is a single shared secret owned by Scentic core. It is **not** per-Firm. Firm scoping is enforced by the `firmId` path parameter combined with the gateway's mapping table, never by the service token alone.
- Rotation is supported via `POST /admin/rotate-secret` (see §6.4) and uses a dual-token window.
- Transport must be TLS in production. The gateway rejects plain HTTP requests carrying a service token when `GATEWAY_NODE_ENV=production` (HSTS-style enforcement at the reverse proxy).

## 6. Endpoint reference

### 6.1 Authentication & Admin

---

#### 6.1.1 `POST /auth/verify`

Verify the service token and return the Firm context the caller is allowed to act on.

- **Auth required:** Yes (`X-Scentic-Service-Token`).
- **Idempotency:** Not required (read-only verification).

**Request body:**

```json
{
  "firmId": "4f1b2c3d-...",
  "actorUserId": "a1b2c3d4-..."
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `firmId` | UUID | Yes | Scentic Firm id. |
| `actorUserId` | UUID | No | Scentic user performing the call. Used for audit, not for authz. |

**200 response:**

```json
{
  "ok": true,
  "data": {
    "firmId": "4f1b2c3d-...",
    "firmActive": true,
    "gatewayFirmEnabled": true,
    "kimaiTeamId": 17,
    "opensignTenantId": "T-9f2a...",
    "actor": {
      "userId": "a1b2c3d4-...",
      "kimaiUserId": 42,
      "opensignUserId": "U-7c1e..."
    },
    "integrations": {
      "kimai": { "enabled": true, "reachable": true },
      "opensign": { "enabled": true, "reachable": true }
    }
  }
}
```

- **401** `INVALID_SERVICE_TOKEN` — missing or wrong token.
- **403** `FIRM_DISABLED` — Firm exists but `gatewayFirmEnabled=false` (offboarded).
- **404** `FIRM_NOT_FOUND` — Firm has no mapping row in the gateway.
- **Retry:** Safe to retry. Not idempotency-cached.
- **Audit event:** `auth.verify` with `{firmId, actorUserId, success}`.
- **Data minimization:** Returns only ids and booleans. Never returns Kimai/OpenSign secrets, API tokens, or PII beyond what Scentic already owns.

---

#### 6.1.2 `GET /health`

Liveness + upstream reachability. No auth required.

**200 response:**

```json
{
  "ok": true,
  "data": {
    "status": "healthy",
    "uptime": 12345,
    "gateway": { "version": "0.1.0", "nodeEnv": "production" },
    "kimai": { "reachable": true, "latencyMs": 12, "version": "2.21.0" },
    "opensign": { "reachable": true, "latencyMs": 8 },
    "checks": {
      "idempotencyStore": "ok",
      "mappingStore": "ok"
    }
  }
}
```

- **503** `UNAVAILABLE` — returned with partial `data` when at least one critical upstream is unreachable. `data.status` becomes `"degraded"`.
- **Retry:** Safe to retry; clients should back off exponentially.
- **Audit event:** none (read-only probe).
- **Data minimization:** No Firm or user data. Version strings only.

---

#### 6.1.3 `POST /admin/init-firm`

Initialize a Scentic Firm in both Kimai (team) and OpenSign (tenant + team). Idempotent: repeated calls for the same `firmId` return the existing mapping rather than recreating.

- **Auth required:** Yes.
- **Idempotency:** **Required.**

**Request body:**

```json
{
  "firmId": "4f1b2c3d-...",
  "firmName": "Carved Oak LLP",
  "integrations": {
    "kimai": { "enabled": true, "teamName": "Carved Oak LLP" },
    "opensign": { "enabled": true, "tenantName": "Carved Oak LLP" }
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `firmId` | UUID | Yes | Must match a Scentic Firm. |
| `firmName` | string (1–200) | Yes | Used as Kimai team name and OpenSign tenant name. Must be sanitized (see data minimization). |
| `integrations.kimai.enabled` | boolean | Yes | If `false`, no Kimai team is created. |
| `integrations.opensign.enabled` | boolean | Yes | If `false`, no OpenSign tenant is created. |

**201 response (first init):**

```json
{
  "ok": true,
  "data": {
    "firmId": "4f1b2c3d-...",
    "kimai": { "teamId": 17, "teamName": "Carved Oak LLP" },
    "opensign": { "tenantId": "T-9f2a...", "teamId": "TM-3a1b..." },
    "createdAt": "2026-07-31T12:00:00Z"
  }
}
```

- **200** (idempotent replay) — same body as 201 with `X-Idempotent-Replay: true`.
- **400** `INVALID_INPUT` — malformed body, bad name length.
- **409** `FIRM_ALREADY_INITIALIZED` — only when key reuse with different body (handled by idempotency layer as `IDEMPOTENCY_KEY_REUSE`).
- **502** `KIMAI_UNREACHABLE` / `OPENSIGN_UNREACHABLE` — partial failure. If Kimai succeeded but OpenSign failed, the response is `502` with `data.partial = { kimai: {...}, opensign: null }` and the client must retry with the same idempotency key. The gateway records the partial state and resumes on retry.
- **Retry:** Safe. Partial failures resume via idempotency key.
- **Audit event:** `admin.firm.init` with `{firmId, firmName, kimaiTeamId, opensignTenantId, actorUserId}`.
- **Data minimization:** Only `firmName` is sent upstream. No client names, matter names, or user PII in this call.

---

#### 6.1.4 `POST /admin/disable-firm`

Disable (offboard) a Scentic Firm in the gateway. Marks the Firm mapping disabled, revokes per-Firm upstream credentials, and (configurable) disables/suspends the Kimai team and OpenSign tenant without deleting data. Reversible by re-init only with admin action.

- **Auth required:** Yes.
- **Idempotency:** **Required.**

**Request body:**

```json
{
  "firmId": "4f1b2c3d-...",
  "reason": "offboarded",
  "deleteUpstreamData": false
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `firmId` | UUID | Yes | |
| `reason` | enum (`offboarded`, `suspended`, `admin`) | Yes | Audit reason. |
| `deleteUpstreamData` | boolean | No (default `false`) | If `true`, gateway deletes Kimai team and OpenSign tenant data. Requires separate confirmation token in `X-Confirm-Delete` header. |

**200 response:**

```json
{
  "ok": true,
  "data": {
    "firmId": "4f1b2c3d-...",
    "disabledAt": "2026-07-31T12:05:00Z",
    "kimai": { "action": "team_disabled", "teamId": 17 },
    "opensign": { "action": "tenant_disabled", "tenantId": "T-9f2a..." }
  }
}
```

- **404** `FIRM_NOT_FOUND`.
- **409** `FIRM_ALREADY_DISABLED`.
- **Retry:** Safe.
- **Audit event:** `admin.firm.disable` with full payload.
- **Data minimization:** No new data sent upstream; only state flips.

---

#### 6.1.5 `POST /admin/rotate-secret`

Rotate the `SCENTIC_SERVICE_TOKEN` with a dual-token overlap window. Scentic core supplies the new token; the gateway accepts both old and new for a configurable window (default 10 minutes), then drops the old.

- **Auth required:** Yes (with current valid token).
- **Idempotency:** **Required.**

**Request body:**

```json
{
  "newToken": "<strong-random>",
  "overlapSeconds": 600
}
```

**200 response:**

```json
{
  "ok": true,
  "data": {
    "rotatedAt": "2026-07-31T12:10:00Z",
    "overlapEndsAt": "2026-07-31T12:20:00Z",
    "acceptedTokens": 2
  }
}
```

- **400** `INVALID_INPUT` — weak token (entropy check fails), overlap out of range (60–3600s).
- **Retry:** Safe.
- **Audit event:** `admin.secret.rotate` (token value never logged; only hash).
- **Data minimization:** The new token is stored hashed at rest. The old token's hash is deleted after overlap.

---

#### 6.1.6 `GET /source-offer`

Return AGPL-3.0 source offer information (Section 13 compliance). No auth required (this is the network-user-facing offer).

**200 response:**

```json
{
  "ok": true,
  "data": {
    "license": "AGPL-3.0",
    "sourceOfferUrl": "https://github.com/pulsehound/scentic-agpl-services",
    "upstream": [
      { "name": "Kimai", "url": "https://github.com/kimai/kimai", "license": "AGPL-3.0-or-later" },
      { "name": "OpenSign", "url": "https://github.com/OpenSignLabs/OpenSign", "license": "AGPL-3.0" }
    ],
    "modifications": "No modifications to upstream; tracked as patch files.",
    "buildInstructionsUrl": "https://github.com/pulsehound/scentic-agpl-services/blob/main/docs/DEPLOYMENT.md",
    "contact": "source-request@scentic-test.com"
  }
}
```

- **Audit event:** `source.offer.viewed` (no PII).
- **Data minimization:** No secrets, no Firm data, no proprietary Scentic code references beyond the public repo URL.

### 6.2 Time Tracking (Kimai)

All Kimai routes are scoped by `firmId`. The gateway resolves `firmId` → Kimai team + per-Firm API token from its mapping table and enforces that every Kimai object touched is owned by that team.

---

#### 6.2.1 `PUT /kimai/firm/{firmId}/mapping`

Create or update the Scentic Firm → Kimai team mapping. Usually called once during init; provided separately for repair/admin flows.

- **Auth:** Yes. **Idempotency:** Required.

**Request body:**

```json
{
  "kimaiTeamId": 17,
  "kimaiTeamName": "Carved Oak LLP",
  "apiToken": "<kimai-team-api-token>"
}
```

The `apiToken` is stored encrypted at rest in the gateway mapping store (never returned on subsequent reads, never logged).

**200 response:**

```json
{
  "ok": true,
  "data": {
    "firmId": "4f1b2c3d-...",
    "kimaiTeamId": 17,
    "mappedAt": "2026-07-31T12:00:00Z"
  }
}
```

- **400** `INVALID_INPUT` — bad team id, missing token.
- **409** `KIMAI_TEAM_IN_USE` — team already mapped to a different Firm.
- **Audit event:** `kimai.mapping.firm`.
- **Data minimization:** `apiToken` is write-only; never echoed in responses or logs.

---

#### 6.2.2 `PUT /kimai/firm/{firmId}/users/{userId}/mapping`

Create or update Scentic User → Kimai user mapping.

**Request body:**

```json
{
  "kimaiUserId": 42,
  "kimaiUsername": "jdoe",
  "apiToken": "<per-user-kimai-api-token>"
}
```

**Response:** as 6.2.1 with `userId`, `kimaiUserId`.
- **409** `KIMAI_USER_IN_USE`.
- **Audit event:** `kimai.mapping.user`.

---

#### 6.2.3 `PUT /kimai/firm/{firmId}/clients/{clientId}/mapping`

Create or update Scentic Client → Kimai Customer mapping.

**Request body:**

```json
{
  "kimaiCustomerId": 88,
  "kimaiCustomerName": "CIL International Cargo Inc.",
  "teamId": 17
}
```

`kimaiCustomerName` is the team-scoped display name. The gateway validates that `teamId` matches the Firm's Kimai team.

- **409** `KIMAI_CUSTOMER_IN_USE` — customer mapped to a Client in a different Firm.
- **Audit event:** `kimai.mapping.client`.
- **Data minimization:** Only the client's display name is sent to Kimai. No matter names, no financials, no PII beyond name.

---

#### 6.2.4 `PUT /kimai/firm/{firmId}/matters/{matterId}/mapping`

Create or update Scentic Matter → Kimai Project mapping.

**Request body:**

```json
{
  "kimaiProjectId": 201,
  "kimaiProjectName": "ACQ-IND Acquisition",
  "kimaiCustomerId": 88,
  "teamId": 17
}
```

The gateway validates `kimaiCustomerId` belongs to a Client in the same Firm.

- **409** `KIMAI_PROJECT_IN_USE`.
- **Audit event:** `kimai.mapping.matter`.
- **Data minimization:** Only the matter's billing-safe name is sent. The gateway must reject matter names containing confidential client identifiers not already present in Kimai (configurable allow-list).

---

#### 6.2.5 `PUT /kimai/firm/{firmId}/activities/{activityType}/mapping`

Create or update activity type → Kimai Activity mapping. Activity types are a fixed Scentic enum (`RESEARCH`, `DRAFTING`, `REVIEW`, `CALL`, `COURT`, `ADMIN`, etc.).

**Request body:**

```json
{
  "activityType": "DRAFTING",
  "kimaiActivityId": 5,
  "kimaiActivityName": "Drafting",
  "scope": "global"
}
```

`scope` is `global` (Kimai global activity) or `project` (project-specific activity). For `project`, `kimaiProjectId` is also required.

- **Audit event:** `kimai.mapping.activity`.

---

#### 6.2.6 `GET /kimai/firm/{firmId}/time-entries`

List time entries for the Firm, optionally filtered. Paginated by cursor.

**Query params:**

| Param | Type | Notes |
|-------|------|-------|
| `userId` | UUID | Scentic user id (mapped to Kimai user). |
| `matterId` | UUID | Scentic matter id. |
| `clientId` | UUID | Scentic client id. |
| `from` | ISO date | Inclusive start. |
| `to` | ISO date | Inclusive end. |
| `cursor` | string | Opaque pagination cursor. |
| `limit` | int (1–200) | Default 50. |

**200 response:**

```json
{
  "ok": true,
  "data": {
    "entries": [
      {
        "entryId": "kimai-7711",
        "scenticEntryId": "e1f2...",
        "userId": "a1b2c3d4-...",
        "matterId": "m9n8...",
        "clientId": "c7d6...",
        "activityType": "DRAFTING",
        "start": "2026-07-31T09:00:00Z",
        "end": "2026-07-31T10:30:00Z",
        "durationSeconds": 5400,
        "description": "Drafted NDA clause 4.2",
        "billable": true,
        "rate": { "amount": "350.00", "currency": "USD" },
        "exported": false,
        "updatedAt": "2026-07-31T10:31:00Z"
      }
    ]
  },
  "meta": { "page": { "cursor": "...", "limit": 50, "hasMore": false } }
}
```

- **403** `FIRM_SCOPE_VIOLATION` — a filter references an entity not in `firmId`.
- **Retry:** Safe.
- **Audit event:** `kimai.time.list` with filter summary (no description text).
- **Data minimization:** `description` is returned only to the calling Firm. Never cross-Firm.

---

#### 6.2.7 `POST /kimai/firm/{firmId}/time-entries`

Create a time entry in Kimai.

- **Idempotency:** Required.

**Request body:**

```json
{
  "scenticEntryId": "e1f2...",
  "userId": "a1b2c3d4-...",
  "matterId": "m9n8...",
  "activityType": "DRAFTING",
  "start": "2026-07-31T09:00:00Z",
  "end": "2026-07-31T10:30:00Z",
  "description": "Drafted NDA clause 4.2",
  "billable": true,
  "rate": { "amount": "350.00", "currency": "USD" }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `scenticEntryId` | UUID | Yes | Stable Scentic id; gateway stores `kimaiTimesheetId ↔ scenticEntryId`. |
| `start` / `end` | ISO datetime | Yes | `end` may be omitted for a running entry (Kimai "active" timesheet). |
| `description` | string (0–3000) | No | Free text. Server-side scrubber strips configurable deny-listed patterns (e.g. SSN, account numbers) before forwarding to Kimai. |
| `rate` | object | No | If omitted, Kimai applies the user/project default. |

**201 response:**

```json
{
  "ok": true,
  "data": {
    "entryId": "kimai-7711",
    "scenticEntryId": "e1f2...",
    "durationSeconds": 5400,
    "exported": false,
    "createdAt": "2026-07-31T10:31:00Z"
  }
}
```

- **400** `INVALID_INPUT` — `end` before `start`, unknown `activityType`, unmapped user/matter.
- **404** `MAPPING_NOT_FOUND` — user, matter, or activity has no Kimai mapping. Scentic must create the mapping first.
- **409** `DUPLICATE_SCENTIC_ENTRY` — a time entry with the same `scenticEntryId` already exists for this Firm.
- **422** `UPSTREAM_VALIDATION` — Kimai rejected the payload (returned with `error.upstream` containing the Kimai message).
- **Retry:** Safe with same idempotency key.
- **Audit event:** `kimai.time.create` with `{firmId, entryId, userId, matterId, durationSeconds}`. **Never** logs `description`.
- **Data minimization:** `description` is forwarded to Kimai only; the gateway stores only its hash for change detection, never the plaintext.

---

#### 6.2.8 `PUT /kimai/firm/{firmId}/time-entries/{entryId}`

Update an existing time entry. `entryId` is the gateway's stable `kimai-<id>` identifier.

- **Idempotency:** Required.

**Request body:** partial update; any subset of the create fields except `scenticEntryId` (immutable).

```json
{
  "end": "2026-07-31T11:00:00Z",
  "description": "Drafted NDA clause 4.2 and 4.3",
  "billable": false
}
```

**200 response:** same shape as create response.

- **404** `ENTRY_NOT_FOUND`.
- **409** `ENTRY_EXPORTED` — Kimai marks the timesheet as exported/locked; updates are rejected. Scentic must un-export via admin or create an adjustment entry.
- **Audit event:** `kimai.time.update`.

---

#### 6.2.9 `DELETE /kimai/firm/{firmId}/time-entries/{entryId}`

Soft-delete (Kimai "trash") a time entry. Hard delete requires admin confirmation.

- **Idempotency:** Required.

**Request body:**

```json
{ "hard": false, "reason": "user_correction" }
```

**200 response:**

```json
{
  "ok": true,
  "data": {
    "entryId": "kimai-7711",
    "deletedAt": "2026-07-31T11:05:00Z",
    "hard": false
  }
}
```

- **404** `ENTRY_NOT_FOUND`.
- **409** `ENTRY_EXPORTED` — cannot delete exported entries.
- **Audit event:** `kimai.time.delete`.

---

#### 6.2.10 `POST /kimai/firm/{firmId}/time-entries/export`

Mark a set of time entries as exported in Kimai (lock them). Optionally produce a Kimai export document.

- **Idempotency:** Required.

**Request body:**

```json
{
  "entryIds": ["kimai-7711", "kimai-7712"],
  "exportFormat": "csv"
}
```

**200 response:**

```json
{
  "ok": true,
  "data": {
    "exportedCount": 2,
    "skippedCount": 0,
    "exportUrl": null
  }
}
```

- **404** `ENTRY_NOT_FOUND` (with `details` listing which ids).
- **409** `ALREADY_EXPORTED` — all listed entries already exported.
- **Audit event:** `kimai.time.export` with `{firmId, count, actorUserId}`.

### 6.3 Signature (OpenSign)

All OpenSign routes are scoped by `firmId`. The gateway resolves `firmId` → OpenSign tenant + session token from its mapping table and enforces that every document touched belongs to that tenant.

---

#### 6.3.1 `POST /opensign/firm/{firmId}/workflows`

Create a signing workflow: upload the PDF to OpenSign, create signers, and send. This is a multi-step upstream operation wrapped in one Scentic-facing call.

- **Idempotency:** Required.

**Request body:**

```json
{
  "scenticWorkflowId": "wf-123e...",
  "scenticDocumentVersionId": "dv-456e...",
  "scenticPhysicalFileId": "pf-789e...",
  "document": {
    "fileName": "NDA_AcqInd_v1.pdf",
    "contentType": "application/pdf",
    "sha256": "9f2a...",
    "sizeBytes": 184320,
    "contentBase64": "JVBERi0xLjQK..."
  },
  "signers": [
    {
      "scenticParticipantId": "p-aaa1...",
      "email": "counsel@cilcargo.com",
      "name": "M. Okafor",
      "role": "SIGNER",
      "order": 1,
      "redirectUrl": "https://scentic.test/wf/wf-123e/done"
    }
  ],
  "metadata": {
    "scenticMatterId": "m9n8...",
    "scenticClientId": "c7d6...",
    "scenticFirmId": "4f1b2c3d-...",
    "title": "NDA - ACQ-IND"
  },
  "sendNow": true,
  "emailNotifications": true,
  "retentionDays": 30
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `scenticWorkflowId` | UUID | Yes | Stable Scentic workflow id; stored in gateway mapping. |
| `document.sha256` | hex | Yes | Gateway verifies the uploaded PDF hash matches before sending to OpenSign. |
| `document.contentBase64` | base64 | Yes | PDF content. Max 25 MiB. Gateway re-checks `sizeBytes` and rejects mismatch. |
| `signers[].role` | enum (`SIGNER`, `CC`, `APPROVER`, `WITNESS`) | Yes | Maps to OpenSign signer roles. |
| `signers[].order` | int ≥ 1 | Yes | Routing order. `1` = first. |
| `metadata.title` | string (1–200) | Yes | Stored as the OpenSign document `Name`. Must not contain confidential client info beyond what signers already see (see threat model). |
| `sendNow` | boolean | No (default `true`) | If `false`, workflow is created in draft and sent via a later `send` (out of scope for v1). |
| `retentionDays` | int (1–365) | No (default `30`) | Days to retain the document in OpenSign after completion before gateway deletes it. |

**201 response:**

```json
{
  "ok": true,
  "data": {
    "scenticWorkflowId": "wf-123e...",
    "opensignDocumentId": "D-1a2b...",
    "opensignWorkflowId": "WF-3c4d...",
    "status": "SENT",
    "signers": [
      {
        "scenticParticipantId": "p-aaa1...",
        "opensignSignerId": "S-5e6f...",
        "email": "counsel@cilcargo.com",
        "status": "SENT"
      }
    ],
    "createdAt": "2026-07-31T12:15:00Z"
  }
}
```

- **400** `INVALID_INPUT` — PDF not valid, hash mismatch, no signers, bad email.
- **404** `MAPPING_NOT_FOUND` — Firm has no OpenSign tenant mapping.
- **409** `WORKFLOW_EXISTS` — `scenticWorkflowId` already mapped to an OpenSign document.
- **413** `DOCUMENT_TOO_LARGE` — exceeds 25 MiB.
- **422` `UPSTREAM_VALIDATION` — OpenSign rejected the document.
- **502** `OPENSIGN_UNREACHABLE` — OpenSign API failed mid-flow. The gateway records partial state and resumes on retry with the same idempotency key.
- **Audit event:** `opensign.workflow.create` with `{firmId, workflowId, documentId, signerCount, sha256}`. **Never** logs PDF content, signer emails, or document title beyond a hashed form.
- **Data minimization:** PDF content is uploaded to OpenSign only for signing. After completion + retrieval + `retentionDays`, the gateway deletes the document from OpenSign. Signer emails are required by OpenSign; signers' personal data is limited to email + name.

---

#### 6.3.2 `GET /opensign/firm/{firmId}/workflows/{workflowId}/status`

Get workflow status. `workflowId` is the Scentic `scenticWorkflowId`.

**200 response:**

```json
{
  "ok": true,
  "data": {
    "scenticWorkflowId": "wf-123e...",
    "opensignDocumentId": "D-1a2b...",
    "status": "IN_PROGRESS",
    "signers": [
      {
        "scenticParticipantId": "p-aaa1...",
        "email": "counsel@cilcargo.com",
        "status": "SIGNED",
        "signedAt": "2026-07-31T13:00:00Z"
      }
    ],
    "completedAt": null,
    "expiresAt": "2026-08-30T12:15:00Z"
  }
}
```

`status` enum: `DRAFT`, `SENT`, `IN_PROGRESS`, `COMPLETED`, `DECLINED`, `EXPIRED`, `VOIDED`, `FAILED`.

- **404** `WORKFLOW_NOT_FOUND`.
- **Audit event:** `opensign.workflow.status`.
- **Data minimization:** Signer emails are returned because Scentic already owns them. No PDF content.

---

#### 6.3.3 `POST /opensign/firm/{firmId}/workflows/{workflowId}/remind`

Send a reminder to one or all signers.

- **Idempotency:** Required.

**Request body:**

```json
{
  "scenticParticipantIds": ["p-aaa1..."],
  "message": "Please sign at your earliest convenience."
}
```

If `scenticParticipantIds` is omitted or empty, remind all pending signers.

**200 response:**

```json
{
  "ok": true,
  "data": {
    "remindedCount": 1,
    "remindedAt": "2026-07-31T14:00:00Z"
  }
}
```

- **409** `WORKFLOW_NOT_REMINDABLE` — workflow is `COMPLETED`, `VOIDED`, or `EXPIRED`.
- **Audit event:** `opensign.workflow.remind`.
- **Data minimization:** `message` is forwarded to OpenSign; not stored in gateway beyond hash.

---

#### 6.3.4 `POST /opensign/firm/{firmId}/workflows/{workflowId}/cancel`

Void/cancel the workflow.

- **Idempotency:** Required.

**Request body:**

```json
{ "reason": "matter_settled" }
```

**200 response:**

```json
{
  "ok": true,
  "data": {
    "scenticWorkflowId": "wf-123e...",
    "status": "VOIDED",
    "voidedAt": "2026-07-31T14:30:00Z"
  }
}
```

- **409** `WORKFLOW_NOT_CANCELLABLE` — already `COMPLETED`.
- **Audit event:** `opensign.workflow.cancel`.

---

#### 6.3.5 `POST /opensign/firm/{firmId}/workflows/{workflowId}/delegate`

Delegate a signer to a new signer.

- **Idempotency:** Required.

**Request body:**

```json
{
  "fromScenticParticipantId": "p-aaa1...",
  "toSigner": {
    "scenticParticipantId": "p-bbb2...",
    "email": "partner@cilcargo.com",
    "name": "R. Adeyemi",
    "role": "SIGNER"
  }
}
```

**200 response:**

```json
{
  "ok": true,
  "data": {
    "fromScenticParticipantId": "p-aaa1...",
    "toSigner": { "scenticParticipantId": "p-bbb2...", "opensignSignerId": "S-7g8h...", "status": "SENT" },
    "delegatedAt": "2026-07-31T15:00:00Z"
  }
}
```

- **404** `PARTICIPANT_NOT_FOUND`.
- **409** `PARTICIPANT_ALREADY_SIGNED` — cannot delegate a signer who has already signed.
- **Audit event:** `opensign.workflow.delegate`.

---

#### 6.3.6 `GET /opensign/firm/{firmId}/workflows/{workflowId}/download`

Download the completed signed PDF. Returns `application/pdf` directly (not the JSON envelope) on success.

**200 response:** `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="NDA_AcqInd_SIGNED.pdf"`, body is the signed PDF bytes.

The gateway first verifies the PDF's signature/certificate integrity before returning it. If verification fails the gateway returns `422` `SIGNED_PDF_INVALID` and does not return bytes.

**Error envelope on failure** uses the standard JSON envelope.

- **404** `WORKFLOW_NOT_FOUND`.
- **409** `WORKFLOW_NOT_COMPLETED` — signed PDF not yet available.
- **422** `SIGNED_PDF_INVALID` — signature verification failed; do not store.
- **Audit event:** `opensign.workflow.download` with `{firmId, workflowId, sha256, bytes}`.
- **Data minimization:** PDF bytes are streamed once; gateway does not persist them beyond the temporary cache used for the signed webhook delivery.

---

#### 6.3.7 `GET /opensign/firm/{firmId}/workflows/{workflowId}/certificate`

Download the audit certificate for the completed workflow. Returns `application/pdf`.

- **404** `WORKFLOW_NOT_FOUND`.
- **409** `WORKFLOW_NOT_COMPLETED`.
- **Audit event:** `opensign.workflow.certificate`.
- **Data minimization:** Certificate contains signer emails, timestamps, and IPs as recorded by OpenSign. These are forwarded only to the owning Firm.

### 6.4 Webhooks (gateway → Scentic)

The gateway is the **source** of these webhooks; Scentic core is the **receiver**. They are delivered to `SCENTIC_CORE_URL + /api/integrations/agpl/events` (Scentic-side route, defined by Scentic core).

All webhook payloads are signed with `GATEWAY_WEBHOOK_SECRET` using HMAC-SHA256 over the canonical body. Signature header: `X-Gateway-Signature: sha256=<hex>`. Scentic must verify the signature in constant time and reject mismatches with `401`.

All webhooks require `X-Idempotency-Key` (gateway-generated) and `X-Correlation-Id`. Scentic must deduplicate by idempotency key.

Delivery semantics: at-least-once. Scentic must process idempotently. The gateway retries with exponential backoff (initial 5s, max 10 min, max 24h total) until Scentic returns 2xx.

---

#### 6.4.1 `POST /webhooks/opensign/events`

OpenSign has **no native webhooks**. The gateway polls OpenSign (`getDocument` per active workflow, configurable interval, default 30s) or subscribes via WebSocket to detect status changes, then emits a signed webhook to Scentic.

**Webhook payload (body sent to Scentic):**

```json
{
  "eventType": "opensign.workflow.completed",
  "eventVersion": 1,
  "eventTimestamp": "2026-07-31T13:30:00Z",
  "firmId": "4f1b2c3d-...",
  "data": {
    "scenticWorkflowId": "wf-123e...",
    "opensignDocumentId": "D-1a2b...",
    "status": "COMPLETED",
    "completedAt": "2026-07-31T13:30:00Z",
    "signers": [
      {
        "scenticParticipantId": "p-aaa1...",
        "email": "counsel@cilcargo.com",
        "status": "SIGNED",
        "signedAt": "2026-07-31T13:00:00Z"
      }
    ],
    "signedPdf": {
      "available": true,
      "downloadUrl": "https://gateway/scentic/.../download",
      "sha256": "1b2c...",
      "expiresAt": "2026-07-31T13:35:00Z"
    },
    "certificate": {
      "available": true,
      "downloadUrl": "https://gateway/scentic/.../certificate",
      "sha256": "3d4e...",
      "expiresAt": "2026-07-31T13:35:00Z"
    }
  }
}
```

`eventType` values:
- `opensign.workflow.sent` — initial send confirmed.
- `opensign.workflow.viewed` — a signer viewed the document.
- `opensign.workflow.signed` — a single signer signed.
- `opensign.workflow.completed` — all signers done; signed PDF + certificate available.
- `opensign.workflow.declined` — a signer declined.
- `opensign.workflow.expired` — workflow expired.
- `opensign.workflow.voided` — workflow voided.

`downloadUrl` and `certificate.url` are short-lived (default 5 min) pre-signed gateway URLs that require the service token. Scentic must fetch the bytes within `expiresAt`.

- **Scentic expected response:** `200` with `{"ok": true}`. Any 4xx (except `429`) stops retries for that event. 5xx and `429` continue retries.
- **Audit event (gateway-side):** `webhook.opensign.delivered` with `{eventType, workflowId, attempt}`.
- **Data minimization:** The webhook contains no PDF bytes, only metadata + short-lived URLs. Signer emails are present because Scentic owns them.

---

#### 6.4.2 `POST /webhooks/kimai/events`

Emitted when Kimai time entries change **and** Kimai webhooks are configured (optional). If Kimai webhooks are not configured, this event stream is unused and Scentic relies on the `GET /kimai/.../time-entries` polling endpoint.

**Webhook payload:**

```json
{
  "eventType": "kimai.time.entry.updated",
  "eventVersion": 1,
  "eventTimestamp": "2026-07-31T11:10:00Z",
  "firmId": "4f1b2c3d-...",
  "data": {
    "scenticEntryId": "e1f2...",
    "kimaiEntryId": 7711,
    "change": "updated",
    "fields": ["end", "description"],
    "entry": { "...": "same shape as GET time-entries item" }
  }
}
```

`eventType` values: `kimai.time.entry.created`, `kimai.time.entry.updated`, `kimai.time.entry.deleted`, `kimai.time.entry.exported`.

- **Scentic expected response:** `200` with `{"ok": true}`.
- **Audit event:** `webhook.kimai.delivered`.
- **Data minimization:** `description` is forwarded to Scentic (Scentic owns it originally). No cross-Firm data.

---

## 7. Error codes

All errors use the JSON error envelope (§3). `code` is a stable machine-readable string; `message` is human-readable and may change between versions; `details` is a structured array.

### 7.1 Standard error codes

| HTTP | Code | Retryable | Meaning |
|------|------|-----------|---------|
| 400 | `INVALID_INPUT` | No | Request body/query/path failed validation. `details` lists fields. |
| 400 | `IDEMPOTENCY_KEY_REUSE` | No | Same idempotency key reused with a different body. |
| 401 | `UNAUTHORIZED` (`INVALID_SERVICE_TOKEN`) | No | Missing or wrong `X-Scentic-Service-Token`. |
| 403 | `FORBIDDEN` (`FIRM_SCOPE_VIOLATION`) | No | Caller attempted to access an entity outside `firmId`. |
| 403 | `FIRM_DISABLED` | No | Firm is offboarded. |
| 404 | `NOT_FOUND` (`FIRM_NOT_FOUND`, `MAPPING_NOT_FOUND`, `ENTRY_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `PARTICIPANT_NOT_FOUND`) | No | Referenced resource does not exist in the gateway mapping or upstream. |
| 409 | `CONFLICT` (`FIRM_ALREADY_INITIALIZED`, `FIRM_ALREADY_DISABLED`, `KIMAI_TEAM_IN_USE`, `KIMAI_USER_IN_USE`, `KIMAI_CUSTOMER_IN_USE`, `KIMAI_PROJECT_IN_USE`, `WORKFLOW_EXISTS`, `DUPLICATE_SCENTIC_ENTRY`, `ENTRY_EXPORTED`, `WORKFLOW_NOT_REMINDABLE`, `WORKFLOW_NOT_CANCELLABLE`, `WORKFLOW_NOT_COMPLETED`, `PARTICIPANT_ALREADY_SIGNED`, `ALREADY_EXPORTED`) | Case-by-case | State conflict. `retryable` is `true` only for `WORKFLOW_NOT_COMPLETED`. |
| 413 | `DOCUMENT_TOO_LARGE` | No | PDF exceeds 25 MiB. |
| 422 | `UPSTREAM_VALIDATION` | No | Upstream (Kimai/OpenSign) rejected the payload. `error.upstream` carries the upstream message. |
| 422 | `SIGNED_PDF_INVALID` | No | Signed PDF failed signature/certificate verification. |
| 429 | `RATE_LIMITED` | Yes | Gateway or upstream rate limit hit. Response includes `Retry-After` header (seconds). |
| 500 | `INTERNAL` | Yes | Unexpected gateway error. `correlationId` should be reported. |
| 502 | `BAD_GATEWAY` (`KIMAI_UNREACHABLE`, `OPENSIGN_UNREACHABLE`) | Yes | Upstream unreachable or returned an invalid response. |
| 503 | `UNAVAILABLE` | Yes | Gateway degraded (e.g. idempotency store down). |

### 7.2 Retry behavior

- Clients must retry only when `error.retryable === true` **and** HTTP status is `429`, `500`, `502`, or `503`.
- Retries must use the **same** `X-Idempotency-Key` for side-effecting requests.
- For `429`, honor the `Retry-After` header.
- Default client retry policy: exponential backoff with jitter, base 1s, factor 2, cap 60s, max 8 attempts, total budget 5 min.
- Do not retry `400`, `401`, `403`, `404`, `409` (non-retryable conflict), `413`, `422`.

## 8. Audit events

Every side-effecting request and every webhook delivery emits an audit event stored in the gateway audit log (append-only, retained per policy). Audit events contain:

- `correlationId`, `eventTimestamp`, `actorUserId`, `firmId`, `route`, `method`, `outcome` (`success`/`failure`), `upstreamProvider`, `upstreamDurationMs`.

Audit events **must not** contain: PDF content, document titles in plaintext (hashed only), time entry `description` text in plaintext (hashed only), tokens, secrets, or signer emails in plaintext (hashed only, except where required for delivery to the owning Firm).

## 9. Data minimization summary

| Data | Sent to Kimai | Sent to OpenSign | Returned to Scentic | Logged |
|------|---------------|------------------|---------------------|--------|
| Firm name | Yes (as team name) | Yes (as tenant name) | Yes (ids only) | Hashed |
| Client name | Yes (as customer name, sanitized) | No | Yes | Hashed |
| Matter name | Yes (as project name, sanitized) | Yes (as document title, sanitized) | Yes | Hashed |
| User email | Yes (Kimai user) | Yes (OpenSign user + signer email) | Yes | Hashed |
| Time entry description | Yes (scrubbed) | No | Yes (owning Firm only) | Hashed |
| PDF content | No | Yes (for signing, deleted after retention) | Yes (signed PDF, one fetch) | Never |
| Signer email | No | Yes (required) | Yes (owning Firm only) | Hashed |
| Service token | Never | Never | Never | Never |
| Upstream API tokens | Used for upstream auth | Used for upstream auth | Never | Never |
| Webhook secret | Never | Never | Never (HMAC only) | Never |

## 10. Versioning and compatibility

- Field additions within `v1` are backward-compatible; clients must ignore unknown fields.
- Field removals or semantic changes require `v2` and a deprecation period of at least one Scentic release.
- Enum value additions are backward-compatible; clients must treat unknown enum values as `UNKNOWN` rather than erroring.
- The `eventVersion` field on webhooks is independent of the API version and is bumped on payload shape changes.

## 11. Open questions (AGPL-00)

- Exact Scentic-side webhook receiver route (`/api/integrations/agpl/events` assumed; confirm with Scentic core routing).
- Whether `emailNotifications` on OpenSign workflows is ever `false` in practice (matters for the email-leak threat in the security model).
- Whether Kimai webhooks are configured in production or whether Scentic always polls `GET /kimai/.../time-entries`.
- Per-Firm OpenSign retention policy vs. global default.
