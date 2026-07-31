# Scentic ↔ AGPL Gateway Interface Specification

> **Status:** Authoritative interface specification for the Scentic ↔ AGPL gateway integration. The gateway side is implemented (AGPL-01/02/03); the Scentic-core side is **documentation only** (see `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`). Updated for AGPL-05: webhook events are now persisted in a **Postgres durable outbox** (see §2.5).
>
> **Scope:** Every REST route Scentic calls, every webhook event the gateway dispatches, the HMAC signing rules in both directions, error codes, retry behavior, data minimization, and multi-Firm mapping rules.
>
> **Audience:** Scentic core integration engineers, gateway implementers, security reviewers, `release-gatekeeper`.
>
> **Related:** `docs/API_CONTRACTS.md` (planning contract surface), `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` (Scentic-side changes), `docs/SCENTIC_ENV_VARS_REQUIRED.md` (env vars).

---

## 1. Scentic → Gateway endpoints

27 routes total: **16 Kimai-surface** + **11 OpenSign-surface**. All routes use the `/api/v1` prefix. All non-public routes require HMAC service-to-service auth (§3.1). Public routes (`GET /health`, `GET /source`, `GET /api/v1/status`) require no auth.

Routes are grouped by surface. The Kimai-surface includes health/status, firm + entity mapping sync, time-entry CRUD, export, and firm admin. The OpenSign-surface is the 11 signature endpoints.

### 1.1 Common request/response envelope

All JSON responses use:

```json
{ "ok": true, "data": { ... }, "meta": { ... } }
```

Errors use:

```json
{ "ok": false, "error": { "code": "...", "message": "...", "retryable": false } }
```

### 1.2 Kimai-surface routes (16)

#### K-01 `GET /health` — gateway liveness + upstream reachability

| Field | Value |
|-------|-------|
| Auth | None (public) |
| Idempotency-Key | Not required |
| Request body | none (body hash = `'{}'`) |
| 200 | `{ ok, data: { status, uptime, gateway: {version,nodeEnv}, kimai: {reachable,latencyMs,version}, opensign: {reachable,latencyMs}, checks: {idempotencyStore, mappingStore} } }` |
| 503 | `UNAVAILABLE` (degraded; at least one critical upstream unreachable) |
| Retry | Safe; back off exponentially |

#### K-02 `GET /api/v1/status` — gateway status summary

| Field | Value |
|-------|-------|
| Auth | None (public) |
| Request body | none (body hash = `'{}'`) |
| 200 | `{ ok, data: { status, gatewayVersion, uptime, deps: {...} } }` |

#### K-03 `GET /api/v1/providers/kimai/health` — Kimai provider health

| Field | Value |
|-------|-------|
| Auth | HMAC |
| Request body | none (body hash = `'{}'`) |
| 200 | `{ ok, data: { reachable, latencyMs, version } }` |
| 503 | `UNAVAILABLE` |

#### K-04 `POST /api/v1/firms/:firmId/init` — initialize Firm in Kimai (team)

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ firmName: string }` |
| 200/201 | `{ ok, data: { scenticFirmId, kimaiTeamId, status } }` |
| 400 | `INVALID_INPUT` (`firmName` missing) |
| 502 | `KIMAI_UNREACHABLE` |

#### K-05 `POST /api/v1/firms/:firmId/users/sync` — sync Scentic user → Kimai user

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ scenticUserId, email, firstName?, lastName? }` |
| 200 | `{ ok, data: { scenticUserId, kimaiUserId, status } }` |
| 400 | `INVALID_INPUT` (`scenticUserId`/`email` missing) |
| 502 | `KIMAI_UNREACHABLE` |

#### K-06 `POST /api/v1/firms/:firmId/clients/sync` — sync Scentic client → Kimai customer

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ scenticClientId, clientName }` |
| 200 | `{ ok, data: { scenticClientId, kimaiCustomerId, status } }` |
| 400 | `INVALID_INPUT` |
| 409 | `KIMAI_CUSTOMER_IN_USE` |

#### K-07 `POST /api/v1/firms/:firmId/matters/sync` — sync Scentic matter → Kimai project

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ scenticMatterId, scenticClientId, matterName, matterCode? }` |
| 200 | `{ ok, data: { scenticMatterId, kimaiProjectId, status } }` |
| 400 | `INVALID_INPUT` |
| 409 | `KIMAI_PROJECT_IN_USE` |

#### K-08 `POST /api/v1/firms/:firmId/activities/sync` — sync activity code → Kimai activity

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ scenticActivityCode, activityName }` |
| 200 | `{ ok, data: { scenticActivityCode, kimaiActivityId, status } }` |
| 400 | `INVALID_INPUT` |

#### K-09 `POST /api/v1/firms/:firmId/time-entries` — create time entry

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ scenticUserId, scenticMatterId, scenticActivityCode, scenticTimeEntryId, startAt, endAt?, durationSeconds?, description? }` |
| 201 | `{ ok, data: { scenticTimeEntryId, kimaiTimesheetId, status } }` |
| 400 | `INVALID_INPUT` |
| 404 | `MAPPING_NOT_FOUND` (user/matter/activity unmapped) |
| 409 | `DUPLICATE_SCENTIC_ENTRY` |
| 422 | `UPSTREAM_VALIDATION` |
| 502 | `KIMAI_UNREACHABLE` |

#### K-10 `GET /api/v1/firms/:firmId/time-entries` — list time entries

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Query params | `scenticUserId`, `scenticMatterId`, `startDate`, `endDate` |
| 200 | `{ ok, data: [ { scenticTimeEntryId, kimaiTimesheetId, scenticUserId, scenticMatterId, scenticActivityCode, startAt, endAt, durationSeconds, description, exported } ] }` |
| 403 | `FIRM_SCOPE_VIOLATION` |

#### K-11 `GET /api/v1/firms/:firmId/time-entries/:entryId` — get single time entry

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| 200 | `{ ok, data: { ...entry } }` or `{ ok, data: null }` |
| 403 | `FIRM_SCOPE_VIOLATION` |

#### K-12 `PATCH /api/v1/firms/:firmId/time-entries/:entryId` — update time entry

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ startAt?, endAt?, durationSeconds?, description? }` (partial) |
| 200 | `{ ok, data: { ...entry } }` |
| 404 | `ENTRY_NOT_FOUND` |
| 409 | `ENTRY_EXPORTED` |

#### K-13 `DELETE /api/v1/firms/:firmId/time-entries/:entryId` — delete time entry

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| 200 | `{ ok, data: null }` |
| 404 | `ENTRY_NOT_FOUND` |
| 409 | `ENTRY_EXPORTED` |

#### K-14 `POST /api/v1/firms/:firmId/time-entries/export` — export (lock) time entries

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ scenticUserId?, scenticMatterId?, startDate?, endDate?, format? }` |
| 200 | `{ ok, data: { exportedCount, skippedCount, exportUrl } }` |
| 404 | `ENTRY_NOT_FOUND` |
| 409 | `ALREADY_EXPORTED` |

#### K-15 `POST /api/v1/firms/:firmId/disable` — disable (offboard) a Firm

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | (none required; reason optional) |
| 200 | `{ ok, data: { disabled: true } }` |
| 404 | `FIRM_NOT_FOUND` |
| 409 | `FIRM_ALREADY_DISABLED` |

#### K-16 `POST /api/v1/admin/test-connection` — admin connectivity probe

| Field | Value |
|-------|-------|
| Auth | HMAC |
| Idempotency-Key | Recommended |
| 200 | `{ ok, data: { kimai: { reachable, latencyMs } } }` |
| 502 | `KIMAI_UNREACHABLE` |

> `GET /source` (AGPL source-offer endpoint) is intentionally excluded from the 27-route integration surface; it is a compliance endpoint, not an integration call.

### 1.3 OpenSign-surface routes (11)

#### S-01 `GET /api/v1/providers/opensign/health` — OpenSign provider health

| Field | Value |
|-------|-------|
| Auth | HMAC |
| Request body | none (body hash = `'{}'`) |
| 200 | `{ ok, data: { reachable, latencyMs, appId } }` |
| 503 | `UNAVAILABLE` |

#### S-02 `POST /api/v1/firms/:firmId/signature/init` — initialize Firm's OpenSign tenant

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ firmName }` |
| 200/201 | `{ ok, data: { scenticFirmId, opensignTenantId, status } }` |
| 400 | `INVALID_INPUT` |
| 502 | `OPENSIGN_UNREACHABLE` |

#### S-03 `POST /api/v1/firms/:firmId/signature/users/sync` — sync Scentic user → OpenSign user

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ scenticUserId, email, name }` |
| 200 | `{ ok, data: { scenticUserId, opensignUserId, status } }` |
| 400 | `INVALID_INPUT` |
| 502 | `OPENSIGN_UNREACHABLE` |

#### S-04 `POST /api/v1/firms/:firmId/signature/workflows` — create signature workflow

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ scenticSignatureWorkflowId, scenticDocumentId, scenticMatterId?, scenticDocumentVersionId?, scenticPhysicalFileId?, documentName, documentBase64, signers: [{ email, name?, role?, order? }], sendNow? }` |
| 201 | `{ ok, data: { scenticSignatureWorkflowId, opensignDocumentId, status, signers: [{ scenticParticipantId?, opensignSignerId?, email, status }] } }` |
| 400 | `INVALID_INPUT` (PDF invalid, hash mismatch, no signers) |
| 404 | `MAPPING_NOT_FOUND` (no OpenSign tenant for firm) |
| 409 | `WORKFLOW_EXISTS` |
| 413 | `DOCUMENT_TOO_LARGE` (>25 MiB) |
| 422 | `UPSTREAM_VALIDATION` |
| 502 | `OPENSIGN_UNREACHABLE` |

#### S-05 `GET /api/v1/firms/:firmId/signature/workflows/:workflowId` — get workflow status

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| 200 | `{ ok, data: { scenticSignatureWorkflowId, opensignDocumentId, status, signers: [{ email, status, signedAt? }], completedAt?, expiresAt? } }` |
| 404 | `WORKFLOW_NOT_FOUND` |

`status` enum: `DRAFT | SENT | IN_PROGRESS | COMPLETED | DECLINED | EXPIRED | VOIDED | FAILED`.

#### S-06 `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/send` — send draft workflow

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| 200 | `{ ok, data: { scenticSignatureWorkflowId, status: "SENT" } }` |
| 404 | `WORKFLOW_NOT_FOUND` |
| 409 | `WORKFLOW_NOT_SENDABLE` |

#### S-07 `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/cancel` — cancel/void workflow

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ reason? }` |
| 200 | `{ ok, data: { scenticSignatureWorkflowId, status: "VOIDED", voidedAt } }` |
| 404 | `WORKFLOW_NOT_FOUND` |
| 409 | `WORKFLOW_NOT_CANCELLABLE` |

> Maps to OpenSign `declinedoc` (no native void).

#### S-08 `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/remind` — send reminder

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Required |
| Request body | `{ scenticSignerIds?: string[] }` |
| 200 | n/a — see 501 |
| 501 | `NOT_SUPPORTED` — OpenSign has no manual reminder API; automatic reminders are per-document. |

#### S-09 `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/poll` — poll single workflow

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Recommended |
| 200 | `{ ok, data: { scenticSignatureWorkflowId, status, changed: boolean, events: [...] } }` |
| 404 | `WORKFLOW_NOT_FOUND` |

#### S-10 `GET /api/v1/firms/:firmId/signature/workflows/:workflowId/completed` — completed-PDF status

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| 200 | `{ ok, data: { scenticSignatureWorkflowId, signedPdf: { available, downloadUrl?, sha256?, expiresAt? }, certificate: { available, downloadUrl?, sha256?, expiresAt? } } }` |
| 404 | `WORKFLOW_NOT_FOUND` |
| 409 | `WORKFLOW_NOT_COMPLETED` |
| 422 | `SIGNED_PDF_INVALID` |

`downloadUrl`/`certificate.downloadUrl` are short-lived (default 5 min) pre-signed gateway URLs that require the HMAC service token. Scentic must fetch bytes within `expiresAt`.

#### S-11 `POST /api/v1/firms/:firmId/signature/poll-due` — poll all due workflows for a Firm

| Field | Value |
|-------|-------|
| Auth | HMAC + firm path match |
| Idempotency-Key | Recommended |
| 200 | `{ ok, data: { polled: number, changed: number, events: [...] } }` |

### 1.4 HMAC signing rules (Scentic → Gateway)

Every non-public request must be HMAC-signed. See §3.1 for the canonical string and headers.

- **Idempotency key:** required for all writes (`POST`, `PATCH`, `DELETE`). Header `Idempotency-Key` (UUIDv4). The gateway caches `(key, route, status, response)` for 24h; replay returns the original response with `X-Idempotent-Replay: true`. Reuse with a different body → `409 IDEMPOTENCY_KEY_REUSE`.
- **Body hash for bodyless requests:** `JSON.stringify({}) = '{}'`. Do not omit the body hash, do not hash the empty string, do not hash `undefined`. This matches `express.json()` initializing `req.body = {}` for GET/DELETE-without-body.
- **Correlation ID propagation:** Scentic sends `X-Scentic-Correlation-Id` (UUIDv4); the gateway echoes it as `X-Correlation-Id` on the response. If absent, the gateway generates one.

---

## 2. Gateway → Scentic webhook events

The gateway dispatches signed webhooks to `{SCENTIC_WEBHOOK_TARGET_URL}` (Scentic-side receiver route). **21 event types**: 9 Kimai + 12 OpenSign. Delivery is at-least-once; Scentic must process idempotently.

> **AGPL-05 durability note:** events are persisted in a **Postgres outbox** (`outbox_events` table) before dispatch, so they survive gateway restarts. Multiple gateway instances process the outbox concurrently via `SELECT ... FOR UPDATE SKIP LOCKED`, so each event is delivered by exactly one instance. The at-least-once delivery model and the `Idempotency-Key` deduplication requirement on Scentic core are unchanged (see §2.5).

### 2.1 Webhook payload schema

All events share this envelope (see `gateway/src/events/webhook-types.ts`):

```json
{
  "eventType": "OPENSIGN_WORKFLOW_COMPLETED",
  "eventVersion": 1,
  "eventId": "<uuid>",
  "scenticFirmId": "<firm-uuid>",
  "scenticUserId": "<user-uuid | null>",
  "scenticMatterId": "<matter-uuid | null>",
  "scenticDocumentId": "<doc-uuid | null>",
  "scenticDocumentVersionId": "<dv-uuid | null>",
  "scenticPhysicalFileId": "<pf-uuid | null>",
  "scenticSignatureWorkflowId": "<wf-uuid | null>",
  "externalProvider": "kimai" | "opensign",
  "externalObjectRef": "<kimaiTimesheetId | opensignDocumentId | kimaiTeamId | null>",
  "safeSummary": "<no secrets, no confidential matter names>",
  "payload": { /* event-specific fields */ },
  "occurredAt": "<ISO8601>",
  "correlationId": "<uuid>",
  "idempotencyKey": "evt-<eventId>"
}
```

`safeSummary` never contains secrets, PDF content, raw signer emails, or confidential matter names.

### 2.2 Webhook signature headers

Every webhook carries (see `gateway/src/events/webhook-signer.ts`):

| Header | Purpose |
|--------|---------|
| `X-Gateway-Signature` | `sha256=<hex HMAC-SHA256>` over the canonical string (§3.2) |
| `X-Gateway-Timestamp` | Unix epoch milliseconds (string) |
| `X-Gateway-Nonce` | UUIDv4 per event |
| `X-Gateway-Event-Id` | equals `payload.eventId` |
| `X-Gateway-Firm-Id` | equals `payload.scenticFirmId` |
| `X-Gateway-Correlation-Id` | equals `payload.correlationId` |
| `Idempotency-Key` | equals `payload.idempotencyKey` (`evt-<eventId>`) |
| `Content-Type` | `application/json` |

### 2.3 Signature verification (Scentic receiver)

1. Read the **raw body** (not parsed JSON). The HMAC is over the exact bytes sent.
2. Strip the `sha256=` prefix from `X-Gateway-Signature`; compare the remaining hex with the computed HMAC in **constant time** (`timingSafeEqual`). Mismatch → `401`, no processing.
3. Check `X-Gateway-Timestamp` is within ±5 min of server time. Outside → `401`.
4. Check `X-Gateway-Nonce` has not been seen (Redis-backed nonce store in production; in-memory acceptable for dev). Replayed nonce → `401`.
5. Verify `X-Gateway-Firm-Id` matches `payload.scenticFirmId` and the targeted workflow's `firmId`. Mismatch → `403`.
6. Deduplicate by `Idempotency-Key`. If already processed → `200` (idempotent), no re-processing.

### 2.4 Event types (21)

#### Kimai events (9)

| eventType | externalProvider | Trigger | `payload` fields | `safeSummary` example |
|-----------|------------------|---------|------------------|------------------------|
| `KIMAI_CONNECTION_HEALTH_CHANGED` | kimai | Kimai reachability changed | `{ reachable, latencyMs, previousState, newState }` | `"Kimai connection: down → up"` |
| `KIMAI_FIRM_INITIALIZED` | kimai | Firm init completed | `{ scenticFirmId, kimaiTeamId }` | `"Firm initialized in Kimai"` |
| `KIMAI_MAPPING_CREATED` | kimai | Entity mapping created | `{ scenticEntityType, scenticEntityId, kimaiEntityId }` | `"Mapping created: client"` |
| `KIMAI_MAPPING_FAILED` | kimai | Entity mapping failed | `{ scenticEntityType, scenticEntityId, error }` | `"Mapping failed: matter"` |
| `KIMAI_TIME_ENTRY_CREATED` | kimai | Time entry created | `{ scenticTimeEntryId, kimaiTimesheetId, scenticUserId, scenticMatterId, durationSeconds }` | `"Time entry created"` |
| `KIMAI_TIME_ENTRY_UPDATED` | kimai | Time entry updated | `{ scenticTimeEntryId, kimaiTimesheetId, changedFields }` | `"Time entry updated"` |
| `KIMAI_TIME_ENTRY_DELETED` | kimai | Time entry deleted | `{ scenticTimeEntryId, kimaiTimesheetId }` | `"Time entry deleted"` |
| `KIMAI_TIME_ENTRY_EXPORT_READY` | kimai | Export produced | `{ exportUrl, entryCount, format }` | `"Export ready: 12 entries"` |
| `KIMAI_SYNC_FAILED` | kimai | Sync operation failed | `{ operation, error }` | `"Sync failed: users"` |

> Time-entry events never include the `description` text in `safeSummary` or in `payload` beyond a hash; the plaintext `description` is owned by Scentic and is not echoed back.

#### OpenSign events (12)

| eventType | externalProvider | Trigger | `payload` fields | `safeSummary` example |
|-----------|------------------|---------|------------------|------------------------|
| `OPENSIGN_CONNECTION_HEALTH_CHANGED` | opensign | OpenSign reachability changed | `{ reachable, latencyMs, previousState, newState }` | `"OpenSign connection: down → up"` |
| `OPENSIGN_FIRM_INITIALIZED` | opensign | Firm tenant init completed | `{ scenticFirmId, opensignTenantId }` | `"Firm initialized in OpenSign"` |
| `OPENSIGN_USER_SYNCED` | opensign | User synced to OpenSign | `{ scenticUserId, opensignUserId }` | `"User synced"` |
| `OPENSIGN_WORKFLOW_CREATED` | opensign | Workflow created | `{ scenticSignatureWorkflowId, opensignDocumentId, signerCount }` | `"Workflow created"` |
| `OPENSIGN_WORKFLOW_SENT` | opensign | Workflow sent to signers | `{ scenticSignatureWorkflowId, opensignDocumentId }` | `"Workflow sent"` |
| `OPENSIGN_WORKFLOW_STATUS_CHANGED` | opensign | Non-terminal status change | `{ scenticSignatureWorkflowId, previousStatus, newStatus }` | `"Workflow status: SENT → IN_PROGRESS"` |
| `OPENSIGN_WORKFLOW_COMPLETED` | opensign | All signers done | `{ scenticSignatureWorkflowId, opensignDocumentId, completedAt, signers: [{ status, signedAt }] }` | `"Workflow completed"` |
| `OPENSIGN_WORKFLOW_CANCELLED` | opensign | Workflow voided | `{ scenticSignatureWorkflowId, opensignDocumentId, reason }` | `"Workflow cancelled"` |
| `OPENSIGN_WORKFLOW_REMINDER_SENT` | opensign | Automatic reminder sent | `{ scenticSignatureWorkflowId }` | `"Reminder sent"` |
| `OPENSIGN_COMPLETED_PDF_READY` | opensign | Signed PDF available | `{ scenticSignatureWorkflowId, sha256, downloadUrl, expiresAt }` | `"Signed PDF ready"` |
| `OPENSIGN_CERTIFICATE_READY` | opensign | Audit certificate available | `{ scenticSignatureWorkflowId, sha256, downloadUrl, expiresAt }` | `"Certificate ready"` |
| `OPENSIGN_SYNC_FAILED` | opensign | Sync/poll failed | `{ operation, error }` | `"Sync failed: poll"` |

> OpenSign events never include PDF bytes, raw signer emails in `safeSummary` (hashed only), or document titles beyond a hashed form.

### 2.5 Durable outbox (AGPL-05)

As of AGPL-05, the gateway persists every outbound webhook event in a **Postgres durable outbox** before dispatch (`outbox_events` table, `gateway/src/storage/postgres-store.ts`). This does not change the webhook contract (events, headers, payload schema, HMAC are identical to §2.1–§2.4), but it strengthens the delivery guarantees Scentic core can rely on:

- **Persistence:** events survive gateway restarts. A crash mid-dispatch does not lose the event; the dispatcher resumes from the outbox on boot.
- **Multi-instance safety:** multiple gateway instances poll the outbox with `SELECT ... FOR UPDATE SKIP LOCKED`, so each event is claimed and delivered by exactly one instance. Scentic core may receive a given event from any instance; the `X-Gateway-*` headers and HMAC are identical regardless of the dispatching instance.
- **Atomic nonce/idempotency:** nonces use `INSERT ... ON CONFLICT DO NOTHING`; idempotency keys use `INSERT ... ON CONFLICT`. Two concurrent instances cannot accept the same nonce or re-execute the same idempotent write.
- **Outbox payload column is `JSONB`** and stores the full `WebhookPayload` (event type, ids, `safeSummary`). It never stores PDF bytes, raw signer emails (only `signer_email_hash` in `safeSummary`), or HMAC secrets.
- **At-least-once is unchanged.** Scentic core must still deduplicate by `Idempotency-Key` (§2.3 step 6). Because events may now be retried across a longer time window (e.g. after a gateway restart), idempotent deduplication on the Scentic side is more important, not less.

Scentic core does **not** connect to Postgres or read the outbox table directly. It consumes events exclusively via the HMAC-signed HTTP webhook delivery, exactly as in §2.1–§2.4.

---

## 3. HMAC signing rules (both directions)

### 3.1 Scentic → Gateway

**Headers sent by Scentic:**

| Header | Required | Purpose |
|--------|----------|---------|
| `X-Scentic-Timestamp` | Yes | Unix epoch ms (string) |
| `X-Scentic-Nonce` | Yes | UUIDv4 per request |
| `X-Scentic-Signature` | Yes | hex HMAC-SHA256 (no `sha256=` prefix) |
| `X-Scentic-Firm-Id` | Yes | caller's firm id |
| `X-Scentic-User-Id` | Optional | acting user id (audit only) |
| `X-Scentic-Correlation-Id` | Optional | UUIDv4 (gateway generates if absent) |
| `Idempotency-Key` | Required for writes | UUIDv4 |

**Canonical string** (newline-joined, in this exact order — see `gateway/src/auth/hmac.ts`):

```
METHOD
path
queryString
timestamp
nonce
bodyHash
firmId
userId
correlationId
```

- `METHOD` is uppercase (`POST`, `GET`, etc.).
- `path` is the request path without query string.
- `queryString` is the raw query string (empty string if none).
- `bodyHash` is `createHmac('sha256', '').update(bodyBytes).digest('hex')`. For bodyless requests, `body` is `JSON.stringify({}) = '{}'` → hash of the literal string `{}`.
- `firmId`, `userId`, `correlationId` are the header values (empty string if absent for optional ones).

**Verification on gateway side:** constant-time `timingSafeEqual`; timestamp tolerance ±300000 ms (5 min); nonce replay rejected via nonce store.

### 3.2 Gateway → Scentic

**Headers sent by gateway:**

| Header | Purpose |
|--------|---------|
| `X-Gateway-Signature` | `sha256=<hex HMAC-SHA256>` (prefix included) |
| `X-Gateway-Timestamp` | Unix epoch ms (string) |
| `X-Gateway-Nonce` | UUIDv4 per event |
| `X-Gateway-Event-Id` | equals `payload.eventId` |
| `X-Gateway-Firm-Id` | equals `payload.scenticFirmId` |
| `X-Gateway-Correlation-Id` | equals `payload.correlationId` |
| `Idempotency-Key` | `evt-<eventId>` |

**Canonical string** (newline-joined, in this exact order — see `gateway/src/events/webhook-signer.ts`):

```
body
timestamp
nonce
eventId
firmId
correlationId
```

- `body` is the exact JSON string sent as the request body (the serialized `WebhookPayload`).
- `timestamp`, `nonce`, `eventId`, `firmId`, `correlationId` are the header values.

**Verification on Scentic side:** strip `sha256=` prefix; constant-time compare; timestamp ±5 min; nonce replay rejected; deduplicate by `Idempotency-Key`.

### 3.3 Key separation

- `SCENTIC_AGPL_GATEWAY_HMAC_SECRET` (Scentic-side name) / `SCENTIC_SHARED_HMAC_SECRET` (gateway-side name) signs Scentic → Gateway requests.
- `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET` (Scentic-side name) / `SCENTIC_WEBHOOK_HMAC_SECRET` (gateway-side name) signs Gateway → Scentic webhooks.
- The two secrets MUST be distinct values, stored in separate Secret Manager secrets, and rotated independently.

---

## 4. Error codes

Full table. `code` is stable and machine-readable; `message` is human-readable and may change.

| HTTP | Code | Retryable | Meaning |
|------|------|-----------|---------|
| 400 | `INVALID_INPUT` | No | Body/query/path failed validation. `details` lists fields. |
| 400 | `IDEMPOTENCY_KEY_REUSE` | No | Same idempotency key reused with a different body. |
| 401 | `UNAUTHORIZED` / `INVALID_SERVICE_TOKEN` | No | Missing/wrong HMAC signature or required headers. |
| 403 | `FORBIDDEN` / `FIRM_SCOPE_VIOLATION` | No | Caller accessed an entity outside `firmId`. |
| 403 | `FIRM_DISABLED` | No | Firm is offboarded. |
| 404 | `NOT_FOUND` (`FIRM_NOT_FOUND`, `MAPPING_NOT_FOUND`, `ENTRY_NOT_FOUND`, `WORKFLOW_NOT_FOUND`, `PARTICIPANT_NOT_FOUND`) | No | Referenced resource does not exist. |
| 409 | `CONFLICT` (`FIRM_ALREADY_INITIALIZED`, `FIRM_ALREADY_DISABLED`, `KIMAI_TEAM_IN_USE`, `KIMAI_USER_IN_USE`, `KIMAI_CUSTOMER_IN_USE`, `KIMAI_PROJECT_IN_USE`, `WORKFLOW_EXISTS`, `DUPLICATE_SCENTIC_ENTRY`, `ENTRY_EXPORTED`, `WORKFLOW_NOT_REMINDABLE`, `WORKFLOW_NOT_CANCELLABLE`, `WORKFLOW_NOT_COMPLETED`, `WORKFLOW_NOT_SENDABLE`, `PARTICIPANT_ALREADY_SIGNED`, `ALREADY_EXPORTED`) | Case-by-case | State conflict. `retryable` is `true` only for `WORKFLOW_NOT_COMPLETED`. |
| 413 | `DOCUMENT_TOO_LARGE` | No | PDF exceeds 25 MiB. |
| 422 | `UPSTREAM_VALIDATION` | No | Kimai/OpenSign rejected the payload. `error.upstream` carries the upstream message. |
| 422 | `SIGNED_PDF_INVALID` | No | Signed PDF failed signature/certificate verification. |
| 429 | `RATE_LIMITED` | Yes | Rate limit hit. Honor `Retry-After` header. |
| 500 | `INTERNAL` | Yes | Unexpected gateway error. Report `correlationId`. |
| 501 | `NOT_SUPPORTED` | No | Operation not supported by upstream (e.g. OpenSign manual reminders). |
| 502 | `BAD_GATEWAY` (`KIMAI_UNREACHABLE`, `OPENSIGN_UNREACHABLE`) | Yes | Upstream unreachable or invalid response. |
| 503 | `UNAVAILABLE` | Yes | Gateway degraded (idempotency/mapping store down). |

---

## 5. Retry behavior

- **Retry only when** `error.retryable === true` **and** HTTP status is `429`, `500`, `502`, or `503`.
- **Do not retry** `400`, `401`, `403`, `404`, `409` (non-retryable conflict), `413`, `422`, `501`.
- **Idempotency key reuse:** for side-effecting retries, reuse the **same** `Idempotency-Key`. The gateway returns the original cached response (no re-execution). Reuse with a different body → `409 IDEMPOTENCY_KEY_REUSE`.
- **Backoff:** exponential with jitter. Base 1s, factor 2, cap 60s, max 8 attempts, total budget 5 min (Scentic → Gateway). The gateway's webhook dispatcher uses base 5s, cap 10 min, max 24h total (Gateway → Scentic).
- **`429`:** honor the `Retry-After` header (seconds).
- **Webhook delivery (Gateway → Scentic):** at-least-once. `2xx` → delivered. `4xx` (except `429`) → stop retries for that event. `5xx` / `429` → retry with backoff.

---

## 6. Data minimization

What data flows where. "Hashed" means a salted hash is logged; the plaintext is not logged.

| Data | → Kimai | → OpenSign | → Scentic (response/webhook) | Logged |
|------|---------|------------|-------------------------------|--------|
| Firm name | Yes (team name) | Yes (tenant name) | Yes (ids only) | Hashed |
| Client name | Yes (sanitized customer name) | No | Yes | Hashed |
| Matter name | Yes (sanitized project name) | Yes (sanitized document title) | Yes | Hashed |
| User email | Yes (Kimai user) | Yes (OpenSign user + signer) | Yes | Hashed |
| Time entry description | Yes (scrubbed) | No | Yes (owning Firm only) | Hashed |
| PDF content | No | Yes (for signing; deleted after retention) | Yes (signed PDF, one fetch via short-lived URL) | Never |
| Signer email | No | Yes (required) | Yes (owning Firm only) | Hashed |
| Service/HMAC secrets | Never | Never | Never (HMAC only) | Never |
| Upstream API tokens / master key | Used for upstream auth | Used for upstream auth | Never | Never |

---

## 7. Multi-Firm and multi-user mapping rules

### 7.1 Firm scoping

- Every Scentic → Gateway request carries `X-Scentic-Firm-Id`. The gateway's auth middleware verifies the path `:firmId` matches the signed `X-Scentic-Firm-Id` (see `extractFirmIdFromPath` in `gateway/src/auth/scentic-auth.ts`). Mismatch → `403 FIRM_SCOPE_VIOLATION`.
- The gateway resolves `firmId → kimaiTeamId` and `firmId → opensignTenantId` from its own mapping table before any upstream call. All upstream queries are team/tenant-scoped.
- The mapping table enforces uniqueness: a Kimai team or OpenSign tenant maps to at most one Scentic firm.

### 7.2 Cross-firm rejection

- A request signed with Firm A's `X-Scentic-Firm-Id` cannot address Firm B's `:firmId` path → `403`.
- A request from Firm A cannot list/read/modify Firm B's time entries, mappings, or workflows → `404` (the firm-scoped mapping store returns nothing for Firm B's entities from a Firm A context) or `403`.
- Webhooks carry `X-Gateway-Firm-Id` and `payload.scenticFirmId`; Scentic must reject webhooks where these do not match the targeted workflow's `firmId` → `403`.

### 7.3 Per-firm tokens

- The **service/HMAC secret is shared** across firms (one secret per Scentic ↔ gateway deployment). Firm scoping is enforced by the signed `firmId` + path match + mapping table, **not** by per-firm tokens.
- **Upstream** credentials are per-firm where applicable: Kimai per-user API tokens (carried gap: currently uses `KIMAI_ADMIN_API_TOKEN` fallback), OpenSign per-user session tokens (carried gap: currently uses master key). These are owned by the gateway and never exposed to Scentic.
- **Webhook secret** is shared across firms (one secret per deployment); firm isolation in webhooks is enforced by `X-Gateway-Firm-Id` + `payload.scenticFirmId` matching the workflow's `firmId`.

### 7.4 Scentic-side mapping

Scentic does **not** maintain a `ProviderMapping` row for AGPL workflows. Scentic stores only `SignatureWorkflow.providerType = AGPL_GATEWAY` and `SignatureWorkflow.providerEnvelopeId = <gateway workflow id>`. The gateway owns the Scentic ↔ Kimai/OpenSign mapping. See `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` §8.

---

## References

- `docs/API_CONTRACTS.md` — planning contract surface (superset; this spec reflects the implemented routes).
- `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` — Scentic-side changes (documentation only, incl. §13 Postgres durable outbox note).
- `docs/SCENTIC_ENV_VARS_REQUIRED.md` — env vars (incl. gateway-side Postgres vars, §7).
- `docs/SECURITY_THREAT_MODEL.md` — T-03 (webhook spoofing), T-04 (replay), T-17 (Postgres durable store).
- `gateway/src/auth/hmac.ts` — canonical string + signature computation.
- `gateway/src/auth/scentic-auth.ts` — request auth middleware.
- `gateway/src/events/webhook-signer.ts` — webhook signing.
- `gateway/src/events/webhook-types.ts` — webhook payload/headers types.
- `gateway/src/events/outbox.ts` — 21 event types.
- `gateway/src/storage/postgres-store.ts` — Postgres durable outbox (AGPL-05).
- `gateway/src/storage/postgres-schema.sql` — Postgres DDL (`outbox_events`, `nonces`, `idempotency_keys`).
