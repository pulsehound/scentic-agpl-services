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

### 5.1 Bodyless request canonical hash rule

For requests with no body (GET, DELETE without body), `express.json()` initializes `req.body` to `{}` (empty object). The body hash is therefore computed as `JSON.stringify({}) = '{}'`. All Scentic-core signers must replicate this behavior for bodyless requests: do not omit the body hash, do not hash the empty string, and do not hash `undefined` — hash the literal JSON string `{}`. Failing to replicate this produces a signature mismatch and a `401 UNAUTHORIZED` from the gateway.

### 5.2 Token model

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

#### 6.3.0 Implemented `/signature/` routes

The routes in `gateway/src/routes/signature.ts`, which are the Scentic-facing signature endpoints. All require HMAC auth; all but the first two are scoped to the firm in the path. §6.3.1–6.3.7 below are the contract planned before any of this was built and are kept for history: where they differ from this table and from §6.3.9, this table and §6.3.9 are what exists.

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/v1/providers/opensign/health` | Whether OpenSign is reachable. |
| `GET`  | `/api/v1/providers/capabilities` | What the signing service supports, by name (`supported` / `emulated` / `unsupported`). |
| `POST` | `/api/v1/firms/:firmId/signature/init` | Initialize a firm's OpenSign tenant (idempotent). Body `{ firmName }`. |
| `POST` | `/api/v1/firms/:firmId/signature/users/sync` | Sync a Scentic user. Body `{ scenticUserId, email, name }`. |
| `POST` | `/api/v1/firms/:firmId/signature/workflows` | Create a workflow: upload the PDF, place the fields, link the signers, and (unless Scentic delivers) mail the first invitation. Idempotent by `scenticSignatureWorkflowId`. Options include `sendInOrder`, `scenticDelivers`, `ceremony` (§6.3.9.5). |
| `GET`  | `/api/v1/firms/:firmId/signature/workflows/:workflowId` | Status, read fresh from OpenSign (§6.3.9.6). |
| `POST` | `.../workflows/:workflowId/send` | Marks a draft as sent and records the event. Invitations are sent at create. |
| `POST` | `.../workflows/:workflowId/cancel` | Withdraw the request. Body `{ reason }`. The OpenSign document is archived (not declined); status reads `VOIDED`. `409 CONFLICT` once completed. |
| `POST` | `.../workflows/:workflowId/remind` | Mail a reminder to the signers who have not signed. Body `{ signerEmails?: string[], senderName?: string }` (empty list: everyone outstanding). Returns `{ remindedCount }`. The mail links to OpenSign's page, so it is not for `ceremony: 'scentic'` workflows, whose messages Scentic sends. |
| `GET`  | `.../workflows/:workflowId/signers` | Everyone asked to sign, in order: `{ signers: [{ email, role, order, state: 'pending'|'viewed'|'signed'|'declined', signingUrl? }] }`. `signingUrl` is the signer's link to OpenSign's page while it can still be used; it is never given for a `ceremony: 'scentic'` workflow, whose document that page refuses. |
| `POST` | `.../workflows/:workflowId/signers/replace` | Somebody else signs in place of a signer who has not signed. Body `{ fromEmail, toEmail, toName }`. Returns `{ email, signingUrl }` (`signingUrl` is `""` for a `ceremony: 'scentic'` workflow). |
| `POST` | `.../workflows/:workflowId/signers/revoke` | Take a signature back before completion, with any made after it. Body `{ email }`. Returns `{ clearedEmails }`. |
| `POST` | `.../workflows/:workflowId/poll` | Read OpenSign and record a status change (outbox events on transitions). |
| `GET`  | `.../workflows/:workflowId/completed` | Whether the signed PDF and certificate are ready: `{ ready, sha256?, certificateReady }`. |
| `GET`  | `.../workflows/:workflowId/completed/file?kind=signed|certificate` | The executed PDF or its certificate, as bytes, with `X-Content-Sha256`. `409 CONFLICT` until everyone has signed. |
| `GET`  | `.../workflows/:workflowId/ceremony/file` | §6.3.9.1 |
| `POST` | `.../workflows/:workflowId/ceremony/viewed` | §6.3.9.2 |
| `POST` | `.../workflows/:workflowId/ceremony/sign` | §6.3.9.3 |
| `POST` | `.../workflows/:workflowId/ceremony/decline` | §6.3.9.4 |
| `POST` | `.../workflows/:workflowId/expiry` | Change when the request lapses. Body `{ expiresAt }`. §6.3.9.9 |
| `POST` | `/api/v1/firms/:firmId/signature/poll-due` | Poll every workflow of the firm that is not finished. |

A request signed for one firm with another firm's id in the path is `403 FIRM_SCOPE_VIOLATION`. A workflow that belongs to another firm is `404 NOT_FOUND`: the mapping store is firm-scoped, so it is invisible rather than refused.

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

### 6.3.8 Implemented signature surface

See §6.3.0 for the routes that exist and §6.3.9 for the signing ceremony Scentic hosts. This section used to repeat the AGPL-02 route table, and said that `remind` returned `501 NOT_SUPPORTED` and that `cancel` used OpenSign's `declinedoc`; neither has been true since reminders were implemented and cancellation was changed to archive the document.

- All responses use the JSON envelope `{ ok, data }`; errors use the error envelope (§3, §7).
- OpenSign has no webhooks: status changes are found by `poll` / `poll-due` and recorded as outbox events, which the gateway's dispatcher delivers to Scentic (§6.4).

### 6.3.9 The signing ceremony Scentic hosts (round 75)

Implemented in `gateway/src/routes/signature.ts`, `gateway/src/opensign/opensign-service.ts` and `gateway/src/opensign/ceremony.ts`; tested in `gateway/src/tests/signature-ceremony.test.ts`. This section is the contract Scentic's client is written from.

**What it is.** Scentic authenticates the signer itself (an emailed link and an emailed one-time code), shows the document, collects the field values, and stamps them onto the PDF on its own server. It hands the stamped PDF to the gateway, which submits it to OpenSign *for that signer* — the server's own call, with the master key, naming the signer's contact — so OpenSign still counts the signatures, seals the last one and makes the certificate. No session for a signer's OpenSign account is created. OpenSign's own signing page stays deployed and keeps working for `ceremony: 'hosted'` workflows; a `ceremony: 'scentic'` document is closed to it (§6.3.9.8).

**Common to every route below.**

- The four `ceremony/*` routes are for workflows created with `ceremony: 'scentic'`. On any other workflow each answers `409 INVALID_STATE` (`not a Scentic-hosted request`) and nothing is read from or sent to OpenSign.

- HMAC service auth (§5) and the headers of §2. The `X-Scentic-Firm-Id` header must equal `:firmId`, otherwise `403 FIRM_SCOPE_VIOLATION`.
- `:workflowId` is the `scenticSignatureWorkflowId` given at create. A workflow that does not exist, or belongs to another firm, is `404 NOT_FOUND` (`"Workflow not found"`) — the two are not distinguishable.
- Errors use the envelope `{ "ok": false, "error": { "code": string, "message": string, "details"?: [{ "field": string, "issue": string }], "retryable": boolean } }`.
- `email` is matched case-insensitively after trimming. `ipAddress` is one IPv4 or IPv6 address as written (no list, port, brackets or host name), or `""`/absent when unknown. It is sent to OpenSign as the first `X-Forwarded-For` entry, which is the address OpenSign writes in its audit trail and on the certificate; when empty the literal `unknown` is sent, so OpenSign never records the gateway's own address as the signer's.
- The gateway makes no session for a signer's OpenSign account, so there is no token to return, log or store; it never returns or logs the master key.

**Error codes used by the ceremony routes.**

| HTTP | `code` | `retryable` | When |
|------|--------|-------------|------|
| 400 | `INVALID_INPUT` | false | A field is missing or malformed. `details[0].field` names it (`email`, `ipAddress`, `baseSha256`, `pdfBase64`, `signaturePngBase64`, `reason`, `auditEvents`, `auditEvents[3].at`, `ceremony`); `details[0].issue` says why (`required`, `not an email address`, `not an IP address`, `not a SHA-256 in hex`, `not base64`, `not a PDF`, `not a PNG`, `not a date`, `at most 500 events`, `at most 1000 characters`, …). |
| 403 | `FIRM_SCOPE_VIOLATION` | false | The signed firm is not the firm in the path. |
| 403 | `FORBIDDEN` | false | OpenSign itself refused the call for this document (Parse `OPERATION_FORBIDDEN`). Not expected in normal running. |
| 404 | `NOT_FOUND` | false | Unknown workflow (or another firm's). |
| 404 | `NOT_A_SIGNER` | false | `email` is not asked to sign this document (never was, or was replaced). |
| 409 | `ALREADY_SIGNED` | false | That signer has already signed. Nothing is written. Answered before the document's state is looked at: the last signer retrying after a lost response hears this, not `INVALID_STATE`, though the document is by then completed. |
| 409 | `STALE_DOCUMENT` | **true** | `baseSha256` is not the hash of the document's current PDF — somebody else signed in between. Nothing is written. Fetch `ceremony/file` again, stamp again, retry with the new hash. |
| 409 | `INVALID_STATE` | false | The document can no longer be acted on: withdrawn (cancelled/archived), declined, completed, or expired; or the workflow is not one Scentic hosts the signing of (`message` contains `not a Scentic-hosted request`). `message` says which. |
| 409 | `BUSY` | **true** | Another call for the same workflow held its lock for longer than this one would wait (about 25 s). Nothing was written; send the same request again. Also answered by `ceremony/sign` while an earlier signature on the workflow is *in doubt*: it was handed to OpenSign and what became of it is not known — no answer came within 170 s, the connection dropped, or the answer was a 5xx (a 500 from OpenSign, or a 502, 503 or 504 from what stands in front of it), or a 200 that did not say it had signed — so OpenSign may still be recording it. Only a refusal is certain and leaves no mark: any 4xx answer, which includes Parse's 101 (not found) and 119 (forbidden). For up to thirty seconds where the request provably did not get in (a 502, a 503, or no connection made), and up to four minutes after anything else, or until the document's PDF is seen to have changed, no signature is submitted on top of it; the signer it was for hears `ALREADY_SIGNED` as soon as it has landed. See "Concurrency" under `ceremony/sign`. |
| 413 | `PAYLOAD_TOO_LARGE` | false | The stamped PDF is over the configured limit, the signature PNG is over 1 MiB, or the whole request body is over `GATEWAY_JSON_LIMIT` (default `64mb`). |
| 501 | `NOT_SUPPORTED` | false | OpenSign is not enabled on this gateway. |
| 502 | `UPSTREAM_ERROR` | true | OpenSign failed, was unreachable, or did not answer in time (170 s for a signature; 30 s for a view, a refusal, a document read or a record write; 120 s for fetching the PDF). The message never carries OpenSign's own text. After a timeout OpenSign may still complete what it was asked: retry, and treat `ALREADY_SIGNED` as success. |
| 500 | `INTERNAL_ERROR` | false | Unexpected. |

#### 6.3.9.1 `GET /api/v1/firms/:firmId/signature/workflows/:workflowId/ceremony/file`

The document's **current** PDF: the PDF carrying every signature made so far (OpenSign `SignedUrl`), or the original (`URL`) before anyone has signed.

- Request: no body.
- `200`: the bytes. Headers: `Content-Type: application/pdf`, `Content-Length`, `X-Content-Sha256: <64 lowercase hex — SHA-256 of exactly these bytes>`, `Cache-Control: no-store`.
- The `X-Content-Sha256` value is what a later `ceremony/sign` names as `baseSha256`.
- `409 INVALID_STATE` when the request was withdrawn (cancelled/archived). A declined or completed document can still be read.
- Also `403 FIRM_SCOPE_VIOLATION`, `404 NOT_FOUND`, `502 UPSTREAM_ERROR`.

#### 6.3.9.2 `POST .../ceremony/viewed`

Records OpenSign's "Viewed" audit entry for one signer (OpenSign `triggerevent`, called by the server for that signer's contact).

Request:

```json
{ "email": "signer@example.com", "ipAddress": "203.0.113.7" }
```

Response `200`:

```json
{ "ok": true, "data": { "viewed": true, "recorded": true } }
```

- Idempotent. `recorded` is `true` the first time and `false` when the signer had already viewed, signed or declined — in which case nothing is sent to OpenSign and the first view's time and address stand.
- Errors: `INVALID_INPUT` (`email`, `ipAddress`), `NOT_A_SIGNER`, `INVALID_STATE`, `NOT_FOUND`, `FIRM_SCOPE_VIOLATION`, `UPSTREAM_ERROR`.

#### 6.3.9.3 `POST .../ceremony/sign`

Submits one signer's stamped PDF (OpenSign `signPdf`, called by the server for that signer's contact).

Request:

```json
{
  "email": "signer@example.com",
  "signerName": "Alice Example",
  "pdfBase64": "<base64 of the whole stamped PDF>",
  "signaturePngBase64": "<base64 of a PNG of the signature>",
  "ipAddress": "203.0.113.7",
  "baseSha256": "<X-Content-Sha256 of the ceremony/file the PDF was stamped onto>",
  "auditEvents": [
    {
      "at": "2026-11-19T08:00:00.000Z",
      "event": "Link opened",
      "actor": "Alice Example",
      "email": "signer@example.com",
      "ipAddress": "203.0.113.7",
      "userAgent": "Mozilla/5.0 …",
      "detail": "…"
    }
  ],
  "position": 2,
  "relatedDocuments": [
    { "position": 1, "total": 3, "title": "Engagement letter", "sha256": "<64 hex>" },
    { "position": 2, "total": 3, "title": "Power of attorney", "sha256": "<64 hex>" },
    { "position": 3, "total": 3, "title": "Fee agreement" }
  ]
}
```

| Field | Required | Rule |
|-------|----------|------|
| `email` | yes | A signer on the document who has not signed. |
| `signerName` | yes | The signer's own name, as they confirmed it on Scentic's page. Reduced to plain text on one line (markup, control and direction characters removed) and trimmed; 1–200 characters after that, otherwise `INVALID_INPUT` with `details[0].field = "signerName"` (`required`, `not a string`, `at most 200 characters`). Stored **on the document** as `ScenticSignerNames` — a list of `{ email, name }`, this signer's entry replaced and every other signer's kept — before `signPdf` runs. Never written to OpenSign's contact or account for the address, which OpenSign shares across every firm. It is the name the certificate prints for this signer and the name in the PDF's digital signature (§6.3.9.8). |
| `pdfBase64` | yes | Standard base64 (no data-URL prefix, no whitespace). Decodes to bytes beginning `%PDF`. At most the configured limit: three quarters of (`GATEWAY_JSON_LIMIT` − 3 MiB), 45.75 MiB at the default `64mb`. |
| `signaturePngBase64` | yes | Standard base64 of a PNG, at most 1 MiB decoded and at most 2400 × 1200 pixels. The file is checked, not only its first bytes: a well-formed header (IHDR of 13 bytes with a correct checksum, non-zero dimensions, a bit depth and colour type the PNG specification pairs, not interlaced), image data present and ending in IEND, and that data inflating to exactly the size the header implies (inflated under that cap, so a file holding more than it declares is refused, not decoded). Every chunk is walked and its checksum checked; only `IHDR`, `PLTE`, `tRNS`, `IDAT`, `IEND` and the descriptive `gAMA`, `cHRM`, `sRGB`, `iCCP`, `sBIT`, `bKGD`, `pHYs`, `tIME`, `tEXt`, `zTXt`, `iTXt` are allowed (the text and profile chunks at most 64 KB together); an animated PNG (`acTL`, `fcTL`, `fdAT`), any other chunk, or anything after `IEND` is refused. `details[0].issue` is `image too large` (dimensions, or more data than declared), `not a valid PNG`, or `not a PNG`. A leading `data:image/png;base64,` is accepted and dropped. Stored by OpenSign and drawn on the certificate. |
| `ipAddress` | no | See above. |
| `baseSha256` | yes | 64 hex characters, either case. |
| `auditEvents` | no | Array, at most 500 entries. Each: `at` (required; any string `Date` parses, stored as ISO 8601 UTC), `event` (required, non-empty), `actor` (required string, may be empty), and optional `email`, `ipAddress` (an IP or empty), `userAgent`, `detail`. Every string is reduced to plain text (markup, control and direction characters removed, single line) and cut to 300 characters — `userAgent` to 512, so that a browser's own description of itself is kept whole; `email` is lowercased. One bad entry refuses the whole request (`INVALID_INPUT`, `details[0].field` like `auditEvents[3].at`). Stored on the OpenSign document as `ScenticAudit` **before** `signPdf` runs, sorted by `at`, and printed on the certificate as "Event history" (§6.3.9.7). **Each submission replaces the stored list**, so send the complete history of the request every time, not only this signer's events. Omitted or `null` leaves the stored list as it is. |
| `relatedDocuments` | no | The documents sent to be signed together in one request (round 76). Array, at most 50 entries, kept in the order given. Each: `position` and `total` (required; whole numbers from 1 to 1000, `position` ≤ `total`), `title` (required; reduced to plain text on one line like `signerName`, 1–300 characters after that), and optional `sha256` (64 hex characters, either case, stored lowercase; the SHA-256 of that document's PDF as Scentic holds it). Any other key is dropped. One bad entry refuses the whole request (`INVALID_INPUT`, `details[0].field` like `relatedDocuments[2].title`; issues: `not an array`, `at most 50 documents`, `not an object`, `a whole number from 1 to 1000`, `greater than total`, `required`, `at most 300 characters`, `not a SHA-256 in hex`). Stored on the OpenSign document as `ScenticRelatedDocuments` **before** `signPdf` runs and printed on the certificate as "Documents in this request" (§6.3.9.7). **Each submission's entries are merged into the stored list by `position`**: an entry sent replaces the stored one at its position (keeping the stored `sha256` if it sends none), entries not sent stay, the result is kept in order of position, and nothing is ever removed — a later signer's shorter list, or an empty one, takes no document off the certificate. The document is written only when the merge changes something. If the merged list would pass 50 entries the request is refused (`INVALID_INPUT`, `relatedDocuments`, `at most 50 documents with those already listed`). Omitted or `null` leaves the stored list as it is. |
| `position` | no | Which of `relatedDocuments` this document is: a whole number from 1 to 1000 (`INVALID_INPUT`, `details[0].field = "position"` otherwise). The entry of the merged list with that `position` is stored with `"current": true` and printed "(this document)", and the mark is taken off any other. Without it, or when no entry has that position, the mark stays where an earlier submission put it (nowhere, if none did). Ignored when `relatedDocuments` is not sent. |

Order of work, under a per-workflow lock: read the document → refuse if closed (`INVALID_STATE`) → find the signer (`NOT_A_SIGNER`, `ALREADY_SIGNED`) → fetch the current PDF and compare its SHA-256 with `baseSha256` (`STALE_DOCUMENT`) → write `ScenticSignerNames`, `ScenticAudit` and `ScenticRelatedDocuments` → `signPdf` (master key, the signer's contact, `X-Forwarded-For: <ipAddress>`) → read the document back. A submission refused as stale writes none of them.

Response `200`:

```json
{ "ok": true, "data": { "signed": true, "completed": false, "sha256": "<64 hex>" } }
```

- `completed` is `true` when this was the last signature and OpenSign has sealed the document.
- `sha256`: when `completed` is `false`, the SHA-256 of the submitted PDF — OpenSign stores it untouched, so it is the next `baseSha256`. When `completed` is `true`, the hash OpenSign recorded for the sealed PDF (`DocumentHash`), or `""` if it recorded none. `ceremony/file`'s `X-Content-Sha256` is always authoritative.
- **Concurrency.** Two calls for one workflow (`viewed`, `sign`, `decline`) never run at the same time, on one gateway instance or across several: an in-process lock, and behind it, where the gateway's store is PostgreSQL, a database advisory lock held for the whole call — read, compare, write, `signPdf`. The second of two submissions sees the first's result and gets `STALE_DOCUMENT`. A call that cannot get the lock within about 25 s answers `409 BUSY` (retryable) having done nothing. The lock cannot outlive the instance that took it. (With the SQLite or in-memory store there is only ever one instance, and the in-process lock is all of it.) Scentic's own claim on the request remains a second guard, and `baseSha256` the last.
- **Not idempotent by key.** A retry after a lost response gets `ALREADY_SIGNED` if the first attempt landed; treat that as success after confirming with the status route.
- **A signature in doubt (round 76).** When `signPdf` fails and it is not known whether OpenSign took the signature, the workflow is marked with the hash of the PDF as it stood, and `ceremony/sign` answers `409 BUSY` (retryable) to every signer of that workflow until the document shows what happened or the window is up. The mark is set on **every failure that is not a definite refusal**, for one of two windows:

  | What happened | Window | Why |
  |---|---|---|
  | No connection could be made (refused, the host not found or not resolving, no route, the connection not made in time) | **30 seconds** | The request provably did not reach OpenSign, so a signer is not kept waiting for a write that never started. |
  | Everything else: no answer within 170 s (a timeout), a 502 or a 503 (the front end in front of OpenSign answers so also after it handed the request on, when an instance stopped or a connection broke: round 76, L-3), a 504, a 500, a connection reset or closed once the request was on it (or any failure that does not say how it failed), a 200 that does not report success | **4 minutes** | OpenSign had the request and may still be working on it: a 504 means only that what stands in front gave up waiting. |

  In either window the document is read first, on every call: the signer the lost signature was for hears `ALREADY_SIGNED` as soon as it has landed, and once the PDF is seen to have changed the mark is cleared and the call goes on (to `STALE_DOCUMENT` if its `baseSha256` is the old one). `BUSY` is answered only while nothing has changed. A caller that gets `BUSY` should keep retrying: for a little over thirty seconds after a connection that was never made, for up to four minutes otherwise. It is **not** set on a 4xx answer — Parse's 119 (`403 FORBIDDEN` here), 101 (`409 INVALID_STATE` here), or any other 4xx (`502 UPSTREAM_ERROR` here) — after which the same request may be sent again at once. Before round 76 only a timeout set it. The response to the failed call itself is unchanged (`502 UPSTREAM_ERROR`, retryable).
- Errors: `INVALID_INPUT`, `PAYLOAD_TOO_LARGE`, `NOT_A_SIGNER`, `ALREADY_SIGNED`, `STALE_DOCUMENT`, `INVALID_STATE`, `FORBIDDEN`, `NOT_FOUND`, `FIRM_SCOPE_VIOLATION`, `UPSTREAM_ERROR`.

#### 6.3.9.4 `POST .../ceremony/decline`

One signer refuses the document (OpenSign `declinedoc`, called by the server naming that signer's account). The document is declined for everybody.

Request:

```json
{ "email": "signer@example.com", "reason": "The fee in clause 4 is wrong.", "ipAddress": "203.0.113.7" }
```

- `reason` is required: trimmed, markup and control characters removed (line breaks kept), 1–1000 characters.

Response `200`:

```json
{ "ok": true, "data": { "declined": true } }
```

- Asked again by the same signer after it succeeded: `200` again, nothing sent to OpenSign, the first reason stands.
- A document already declined by somebody else, completed, withdrawn or expired: `INVALID_STATE`. A signer who has signed: `ALREADY_SIGNED`.
- For documents created with `scenticDelivers: true` or `ceremony: 'scentic'`, OpenSign's own "declined" email to the document's creator (the platform's shared admin mailbox) is not sent (`deploy/opensign-server-patches.mjs`); Scentic sends its own notices.
- Errors: `INVALID_INPUT` (`email`, `reason`, `ipAddress`), `NOT_A_SIGNER`, `ALREADY_SIGNED`, `INVALID_STATE`, `FORBIDDEN`, `NOT_FOUND`, `FIRM_SCOPE_VIOLATION`, `UPSTREAM_ERROR`.

#### 6.3.9.5 Create: `ceremony`

`POST /api/v1/firms/:firmId/signature/workflows` accepts four more optional fields:

```json
{
  "ceremony": "scentic",
  "originatorIp": "198.51.100.24",
  "firmName": "Cohen & Levi Law Offices",
  "senderEmail": "dana.levi@cohenlevi.example"
}
```

- `"hosted"` (the default, also when the field is absent): exactly the request sent to OpenSign before this field existed.
- `"scentic"`: OpenSign's `SendinOrder` and `SendInOrderStrict` are both `false` whatever `sendInOrder` says — Scentic enforces the order and lets the signers of one step sign at the same time. The document is marked `ScenticCeremony: true` and closed to OpenSign's own page (§6.3.9.8); if it cannot be closed, the create fails (`502 UPSTREAM_ERROR`) and the document is withdrawn. It also implies `scenticDelivers: true` (the gateway and OpenSign mail nobody; OpenSign's automatic reminders are off), because an invitation from here would link to OpenSign's page. Everything else is as for `hosted`.
- Any other value: `400 INVALID_INPUT` (`details[0].field = "ceremony"`).
- The response (the stored mapping) gains `"ceremony": "hosted" | "scentic"`. Re-creating an existing workflow returns the stored mapping unchanged, including its ceremony.
- The `ceremony/*` routes answer only for `scentic` workflows (`409 INVALID_STATE` otherwise).

**`originatorIp` (round 76).** The IP address of the person who sent the request, as Scentic saw it. Same rule as `ipAddress` on the ceremony routes: one IPv4 or IPv6 address as written (surrounding spaces trimmed), or absent, `null` or `""`; never a list, a port, brackets or a host name — otherwise `400 INVALID_INPUT` with `details[0] = { "field": "originatorIp", "issue": "not an IP address" }`, before anything is uploaded or created. Accepted for either ceremony. When given, it is written on the OpenSign document as `OriginIp`, with the master key, straight after the document is created; that is the field the certificate prints as "Document originator … IP address". (OpenSign fills `OriginIp` itself only from the `x-real-ip` header of whoever calls it, which here is this gateway and carries nobody's address: without `originatorIp` the line is blank, as before.) Not stored in the gateway's own mapping and not returned by any route; re-creating an existing workflow returns the stored mapping and writes nothing.

**`senderEmail` (round 76).** The email address of the person sending the request, for the certificate's "Document originator … Email" line. Optional: absent, `null` or `""` writes nothing. Otherwise one address in plain form — letters, digits and ``.!#$%&'*+/=?^_`{|}~-`` before the `@`, a dotted host name of letters, digits and hyphens after it; no display name, no brackets, no list, no spaces inside — of at most 254 characters, trimmed and lowercased; anything else is `400 INVALID_INPUT` with `details[0] = { "field": "senderEmail", "issue": "not an email address" }`, before anything is uploaded or created. Written on the OpenSign document as `SenderMail`, with the master key, straight after the document is created: that is the field the certificate generator prints (`docDetails.SenderMail`, else the owning account's address). Without it the certificate prints the address of the account that owns the document, which is the platform's one admin account for every firm.

It is printed, not written to. In OpenSign's server `SenderMail` is a recipient in exactly one place: the completion mail, which blind-copies the completed document to it (`pdf/PDF.js`, `sendCompletedMail`). That mail is off unless `SEND_COMPLETION_MAIL=true`, and from round 76 is never sent for a document Scentic delivers (`scenticDelivers: true` or `ceremony: 'scentic'`: the `data-scentic-delivers` marker in the document's template), whatever that setting says (`deploy/opensign-server-patches.mjs`, "completion mail off"; checked at image build). Elsewhere `SenderMail` appears only as the reply-to address and as a variable in the wording of mails addressed to other people (`ForwardDoc.js`, `createBatchDocs.js`, the completion mail, and the signing page's invitation to the next signer): it is named in those mails, not sent them (and the gateway calls neither of the first two). So: with `senderEmail` on a `scenticDelivers`/`scentic` workflow, OpenSign sends that address nothing. On a workflow that is neither, with `SEND_COMPLETION_MAIL=true`, the sender receives OpenSign's blind copy of the completed document, as upstream intends.

**`firmName` (round 76).** The sending firm's name as it is today, for the certificate's "Organization" line (§6.3.9.7). Optional. Reduced to plain text on one line and trimmed; at most 200 characters after that, otherwise `400 INVALID_INPUT` with `details[0].field = "firmName"` (`not a string`, `at most 200 characters`). Written on the document as `ScenticFirmName`. Absent, `null` or empty once cleaned: `ScenticFirmName` is the name the firm was set up with — the `firmName` given to `POST /api/v1/firms/:firmId/signature/init`, kept as the mapping's `opensignTenantName` and **never updated afterwards** (a second init returns the stored mapping), so a firm that has since been renamed should send its name here. The document's `FirmName`, used in the code email, is the set-up name either way, as before. Never the platform's name. `senderName` — the person, "who the invitation says it is from" — is stored as `SenderName` and printed as the originator's name, as before.

#### 6.3.9.6 Status: who declined

`GET /api/v1/firms/:firmId/signature/workflows/:workflowId` → `200`:

```json
{
  "ok": true,
  "data": {
    "status": "DRAFT | SENT | IN_PROGRESS | COMPLETED | DECLINED | EXPIRED | VOIDED | FAILED",
    "opensignDocumentId": "string",
    "ceremony": "hosted | scentic",
    "signers": [
      { "email": "signer@example.com", "status": "Viewed | Signed | declined", "signedAt": "ISO?", "viewedAt": "ISO?", "ipAddress": "string?" }
    ],
    "declineReason": "string | null",
    "declinedByEmail": "signer@example.com | \"\"",
    "expiresAt": "ISO | null",
    "completedPdfReady": false,
    "certificateReady": false
  }
}
```

- `declinedByEmail` is the address of the signer who declined (OpenSign `DeclineBy`, resolved through the document's signers), or `""` when nobody declined or it cannot be told.
- That signer's own entry in `signers` has `status: "declined"` (lowercase); if they had never opened the document an entry `{ "email", "status": "declined" }` is added. Before this, a per-signer declined state could not occur: OpenSign records a refusal on the document and writes nothing to its audit trail.
- `GET .../signers` reports the same signer with `state: "declined"`.

`POST .../poll` → `200` `data` gains two fields: `{ "status", "changed", "completedPdfReady", "certificateReady", "declineReason": "string | null", "declinedByEmail": "string" }`.

#### 6.3.9.7 Capabilities and the certificate

`GET /api/v1/providers/capabilities` gains: `"scenticCeremony": "emulated"`, `"concurrentSigning": "emulated"`, `"perSignerDecline": "supported"`, `"signerConfirmedName": "supported"`, `"changeExpiry": "supported"`, `"certificateEventHistory": "supported"` (`"parallelSigning": "supported"` was already there).

The completion certificate prints `ScenticAudit` as an "Event history" section after the signers (`deploy/opensign-server-patches.mjs`, `deploy/opensign-server-files/scenticEventHistory.js`): one row per event in time order — time as `YYYY-MM-DD HH:mm:ss UTC`, event, who (`actor`, with `email` beneath), IP address (whole; an IPv6 address is drawn smaller rather than cut), and browser (`userAgent`, printed whole: wrapped within its column over as many lines as it needs, the row growing with it; up to the 512 characters kept); `detail` is printed beneath the event. It runs over as many pages as it needs, each continued page headed again. A document with no `ScenticAudit`, or an empty one, gets the certificate it got before.

**Organization (round 76).** The certificate's "Organization" line prints the sending firm's name — the document's `ScenticFirmName`, or `FirmName` on a document created before round 76 — drawn in reading order and cut with `...` if it is wider than the line. Upstream prints the company of the account that owns the document, which here is the platform's one account for every firm: every firm's certificate said "Scentic". That value is printed now only for a document that names no firm (one made on OpenSign's own page, outside the gateway).

**Document originator (round 76).** "Name" prints `SenderName` (create's `senderName`), "Email" prints `SenderMail` (create's `senderEmail`), and "IP address" prints `OriginIp` (create's `originatorIp`) (§6.3.9.5). Where create gave no `senderEmail` or `senderName`, the line prints the owning account's — the platform's one admin account — as upstream does. The name and the address are drawn in reading order and cut with `...` if wider than the line.

**Documents in this request (round 76).** When the document has `ScenticRelatedDocuments` (`relatedDocuments` on `ceremony/sign`), the certificate prints, straight after the Summary block and before "Document originator", a section headed "Documents in this request": one entry per document in order of position — `<position> of <total> — <title>`, followed by `(this document)` on the entry marked current, and `SHA-256 : <hash>` beneath it where one was given. A long title is wrapped, not cut. The section runs over as many pages as it needs (each continued page headed "Documents in this request (continued)"); the originator block and the signers follow it, the originator block never split across pages. At most 50 entries are printed. A document with no such list, or an empty one, gets exactly the certificate it got before: every item at the same place.

**What still names the platform, and why.** The certificate's header image is the platform's logo (`deploy/opensign-assets/logo.png`), and the digital signature on the signed PDF and on the certificate is the platform's: its reason reads `Digitally signed by <ESIGN_NAME, default "Scentic"> for <each signer's confirmed name and address>` on the document and `Digitally signed by <ESIGN_NAME>.` on the certificate made with it (`Digitally signed by <APP_NAME, default "Scentic">.` on a certificate made again later by document id), with that name as the signature's name and `ESIGN_CONTACT` (default `esign@scentic.com`) as its contact. These are left as they are on purpose: the signing certificate (the PFX) is the platform's, and a signature made with it that claimed to be the firm's would say something untrue. No text printed on the certificate itself names the platform once a document carries its firm's name.

Limits, known: at most 500 events are printed. The certificate's font (Times New Roman) has Latin, Greek, Cyrillic, Hebrew and Arabic letters; any other character (Chinese, emoji) is printed as `?`. Right-to-left text (round 78, F-19), everywhere on the certificate (OpenSign's own lines and Scentic's): every string is handed to the drawing in the order it was typed, and the certificate's font writes any string holding a Hebrew or Arabic letter glyph by glyph in the order it is seen from the left, run by run, without full bidirectional layout (a line mixing Hebrew and Latin keeps the order of its runs, the page being left to right; Arabic is drawn unjoined). pdf.js, PDFium, MuPDF and Xpdf read such text back in the order it was typed; PDFium (Chrome) keeps the words of a several-word Hebrew run in the order they are seen when the rest of its line is mostly Latin (a signer's name beside "Security level"), each word's letters right; tools that read in the order written without bidirectional handling (pdfminer, `pdftotext -raw`) read it reversed. No `/ActualText` is written: pdf.js ignores it and PDFium and MuPDF reverse it again. Before round 78 a string beginning with a Hebrew letter that Scentic had already reordered (a confirmed name, the firm, the originator, an event's name) was reversed a second time by pdf-lib's shaper and printed backwards.

#### 6.3.9.9 `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/expiry`

Gives the signers until another date. For either ceremony.

Request:

```json
{ "expiresAt": "2027-01-31T21:59:59.000Z" }
```

- `expiresAt`: a full ISO 8601 date and time with its time zone (`Z` or `±hh:mm`; seconds and fractions optional). Later than now and at most 365 days from now.

Response `200`:

```json
{ "ok": true, "data": { "expiresAt": "2027-01-31T21:59:59.000Z" } }
```

- `expiresAt` in the response is the instant stored, in UTC. The status route (§6.3.9.6) reports the same value from then on.
- What it changes: the OpenSign document's `ExpiryDate`, which is the one field OpenSign's page and the gateway's status compare with now. OpenSign sets it once, at creation, and nothing recomputes it. `TimeToCompleteDays` is not changed.
- A request that has already lapsed (`status: "EXPIRED"`) but is not completed, declined or withdrawn **can** be extended; its status then reads as it would have (`DRAFT`/`IN_PROGRESS`), polling takes it up again, and it can be signed.
- Not idempotent by key, but repeating it with the same value changes nothing further.

Errors:

| HTTP | `code` | `retryable` | When |
|------|--------|-------------|------|
| 400 | `INVALID_INPUT` | false | `details[0].field = "expiresAt"`; `issue` is `not an ISO 8601 date and time with a time zone`, `not a date`, `must be in the future`, or `at most 365 days from now`. |
| 403 | `FIRM_SCOPE_VIOLATION` | false | The signed firm is not the firm in the path. |
| 404 | `NOT_FOUND` | false | Unknown workflow (or another firm's). |
| 409 | `INVALID_STATE` | false | The request is completed, declined or withdrawn. |
| 501 | `NOT_SUPPORTED` | false | OpenSign is not enabled. |
| 502 | `UPSTREAM_ERROR` | true | OpenSign failed or was unreachable. |

#### 6.3.9.8 Names, and OpenSign's own page

**The signer's name.** OpenSign keeps one contact per email address for the whole platform, and it keeps the name it was first given: the second firm to send a document to an address would otherwise have the first firm's name for that person on its certificate. So:

- No gateway response carries a signer's name. Status, `signers`, `poll` and the ceremony routes return addresses, states, times and IP addresses only. The `name` given for a signer at create is passed to OpenSign when the signer is linked (OpenSign's one contact for the address may already carry another name) and is never read back.
- The name on a document is the one its signer confirmed: `signerName` on `ceremony/sign`, stored on that document only.
- The certificate prints, for each signer, the name confirmed for that document; only where a document has none (a `hosted` workflow, signed on OpenSign's page) does it print the contact's name, as before. The same applies to the "signed for" text in the PDF's digital signature, and to the event history where an event gives an address and no `actor`. A confirmed Hebrew name reads right to left and is copied in the order it was typed (round 78).

**OpenSign's page is not a second way in.** A `ceremony: 'scentic'` document has OpenSign's ordering off, so OpenSign's page — which any signer could otherwise reach with the document's id and a code mailed to their own address — would let them sign out of turn. For a document marked `ScenticCeremony: true` (`deploy/opensign-server-patches.mjs`, `deploy/opensign-server-files/SendMailOTPv1.js`):

- no code is mailed for it;
- `getDocument`, `signPdf`, `declinedoc` and `triggerevent` answer the server's own calls (the master key) only, and refuse any signer's session, including that of a signer on the document;
- the gateway takes every signer's account off the document's ACL after linking them (and again after a signer is replaced), so no account but the platform's own can read the document or its files by any other route.

Hosted documents are untouched by all of this. Proven by running the patched functions against fixtures (`deploy/tests/scentic-ceremony-guard.test.mjs`) and by the gateway suite; not yet against a running OpenSign.

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
| 404 | `NOT_A_SIGNER` | No | Signing ceremony (§6.3.9): the address is not asked to sign the document. |
| 409 | `ALREADY_SIGNED` | No | Signing ceremony: that signer has already signed. |
| 409 | `STALE_DOCUMENT` | Yes | Signing ceremony: the PDF the submission was built on is no longer current. Fetch, stamp again, retry. |
| 409 | `BUSY` | Yes | Signing ceremony: another call for the same workflow is in hand. Nothing was done; send the same request again. |
| 409 | `INVALID_STATE` | No | Signing ceremony: the document is withdrawn, declined, completed or expired. |
| 413 | `PAYLOAD_TOO_LARGE` | No | The request body, the stamped PDF or the signature image is over its limit. |
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
