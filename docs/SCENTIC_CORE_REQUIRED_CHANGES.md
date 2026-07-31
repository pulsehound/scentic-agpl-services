# Scentic Core Required Changes — Documentation Only

> **Status:** No changes applied. This document describes what Scentic core would need if Yair decides to integrate.
>
> **Scope:** This is a documentation-only specification of the Scentic proprietary core (`scentic.ai`) changes that would be required to consume the AGPL gateway implemented in this repository. **No Scentic core file was modified.** All code references below are proposed targets, not applied edits. The Scentic core repository was inspected read-only.
>
> **Audience:** Yair (Scentic core owner), Scentic core integration engineers, `release-gatekeeper`.
>
> **Related:** `docs/SCENTIC_INTERFACE_SPEC.md` (full interface), `docs/SCENTIC_ENV_VARS_REQUIRED.md` (env vars), `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` (operator manual).

---

## 0. Summary

Integrating Scentic core with the AGPL gateway requires changes in five areas of the proprietary `scentic.ai` repository, all listed below. **None of these have been applied.** They are scoped, sized, and security-reviewed here so Yair can decide whether and when to land them. The AGPL gateway in this repository is usable today via its own REST surface and a manual test harness; the Scentic-side provider is the bridge that makes the gateway behave like a native Scentic signature provider.

| Area | Scentic core file (proposed target) | Change |
|------|--------------------------------------|--------|
| Provider type | `packages/signature/src/types.ts` | Add `AGPL_GATEWAY` to `ProviderName` |
| Provider impl | `packages/signature/src/signature-providers.ts` | New `AgplGatewaySignatureProvider` + factory branch |
| Env schema | `packages/infra/src/env-schema.ts` | Add `SCENTIC_AGPL_*` vars + production validation |
| Webhook receiver | `apps/web/src/app/api/agpl/webhooks/route.ts` | New route (server-to-server, HMAC-verified) |
| Time tracking | `apps/web/src/app/api/time-entries/...` | New proxy API routes |
| Provider health | `packages/ops/src/types.ts`, `packages/ops/src/provider-health-service.ts` | Add `AGPL_GATEWAY` provider health |
| Audit events | `packages/db/prisma/schema.prisma` (`AuditEventType`) | New AGPL audit event values |

---

## 1. Proposed new provider type

### 1.1 `ProviderName` union

**File:** `packages/signature/src/types.ts` (current union):

```ts
export type ProviderName = 'mock' | 'docusign' | 'docsketch' | 'native' | 'other';
```

**Proposed change:** add `'agpl_gateway'`:

```ts
export type ProviderName = 'mock' | 'docusign' | 'docsketch' | 'native' | 'agpl_gateway' | 'other';
```

The Prisma enum `SignatureProviderType` (in `packages/db/prisma/schema.prisma`) currently lists `MOCK | DOCUSIGN | DOC_SKETCH | NATIVE | OTHER`. A corresponding `AGPL_GATEWAY` enum value and a Prisma migration would be required so `SignatureWorkflow.providerType` can be set to `AGPL_GATEWAY`.

### 1.2 `AgplGatewaySignatureProvider` class

**File:** `packages/signature/src/signature-providers.ts` (new class).

The class must implement the existing `SignatureProvider` interface (8 methods):

| Method | Gateway call |
|--------|--------------|
| `isAvailable()` | `GET /api/v1/providers/opensign/health` (returns boolean; never throws) |
| `sendEnvelope(params)` | `POST /api/v1/firms/:firmId/signature/workflows` |
| `getEnvelopeStatus(envelopeId)` | `GET /api/v1/firms/:firmId/signature/workflows/:workflowId` |
| `sendReminder(envelopeId, signerEmail)` | `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/remind` (note: gateway returns `501 NOT_SUPPORTED`; provider must surface `PROVIDER_ERROR` with the gateway message) |
| `cancelEnvelope(envelopeId, reason)` | `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/cancel` |
| `delegateSigner(...)` | Not exposed by the gateway in AGPL-02/03. Provider returns `PROVIDER_ERROR` (`NOT_SUPPORTED`). Tracked as a carried gap. |
| `downloadSignedDocument(envelopeId)` | `GET /api/v1/firms/:firmId/signature/workflows/:workflowId/completed` (returns signed-PDF readiness + download URL; provider fetches bytes within `expiresAt`) |
| `verifyWebhook(payload, headers)` | Local HMAC verification using `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET` (no gateway call). Maps gateway event types to Scentic `WebhookEvent`/`WebhookEventType`. |

The provider resolves `firmId` from the Scentic caller context (the workflow's `firmId`) and stamps it into the HMAC-signed request headers (see `docs/SCENTIC_INTERFACE_SPEC.md` §3). The `envelopeId` stored on `SignatureWorkflow.providerEnvelopeId` is the gateway workflow id (`scenticSignatureWorkflowId`).

### 1.3 Factory branch

**File:** `packages/signature/src/signature-providers.ts` — `createSignatureProvider()`.

Current factory reads `process.env.SIGNATURE_PROVIDER_TYPE` (uppercased) and returns `MockSignatureProvider` for `MOCK` (rejected in production) or `NullSignatureProvider` otherwise.

**Proposed change:** add a branch reading `SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY` (and the equivalent `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY`):

```ts
if (providerType === 'AGPL_GATEWAY') {
  // Defense-in-depth: reject AGPL_GATEWAY in production if env-schema validation
  // was bypassed and required secrets/URL are missing.
  if (process.env.NODE_ENV === 'production') {
    const url = process.env.SCENTIC_AGPL_GATEWAY_URL;
    const secret = process.env.SCENTIC_AGPL_GATEWAY_HMAC_SECRET;
    if (!url || !secret) {
      throw new Error('AGPL_GATEWAY provider requires SCENTIC_AGPL_GATEWAY_URL and SCENTIC_AGPL_GATEWAY_HMAC_SECRET in production');
    }
  }
  return new AgplGatewaySignatureProvider({
    gatewayUrl: process.env.SCENTIC_AGPL_GATEWAY_URL!,
    hmacSecret: process.env.SCENTIC_AGPL_GATEWAY_HMAC_SECRET!,
    webhookSecret: params?.webhookSecret ?? process.env.SCENTIC_AGPL_WEBHOOK_HMAC_SECRET,
    timeoutMs: Number(process.env.SCENTIC_AGPL_GATEWAY_TIMEOUT_MS ?? 30000),
    retryCount: Number(process.env.SCENTIC_AGPL_GATEWAY_RETRY_COUNT ?? 5),
  });
}
```

The factory remains fail-closed: unknown values still return `NullSignatureProvider`.

---

## 2. Proposed env vars

**File:** `packages/infra/src/env-schema.ts`.

Add the following to the schema (see `docs/SCENTIC_ENV_VARS_REQUIRED.md` for the full table):

| Env var | Type | Required | Production validation |
|---------|------|----------|----------------------|
| `SCENTIC_AGPL_GATEWAY_URL` | string (URL) | Yes (when AGPL enabled) | Must pass `isPrivateUrl()` (RFC 1918 / localhost / `*.local` / `*.internal`). Reject public URLs. |
| `SCENTIC_AGPL_GATEWAY_HMAC_SECRET` | string (secret) | Yes (when AGPL enabled) | Reject placeholders (`changeme`, `dev-secret`, `placeholder`, `xxx`, `test`, empty). |
| `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET` | string (secret) | Yes (when AGPL enabled) | Reject placeholders. Must be **distinct** from `SCENTIC_AGPL_GATEWAY_HMAC_SECRET`. |
| `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE` | string | No | `AGPL_GATEWAY` or `NULL`. |
| `SCENTIC_AGPL_TIME_TRACKING_ENABLED` | boolean | No | — |

**Production validation rules (enforced by `validateEnvironment()` when `NODE_ENV=production`):**

1. Reject placeholder secrets for both `SCENTIC_AGPL_GATEWAY_HMAC_SECRET` and `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET`.
2. Reject public URLs for `SCENTIC_AGPL_GATEWAY_URL` (use existing `isPrivateUrl()` helper).
3. Reject `MOCK` + `AGPL_GATEWAY` mismatch: if `SIGNATURE_PROVIDER_TYPE=MOCK` and `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY` (or vice versa), fail validation. Only one signature provider can be active.
4. Require HTTPS for `SCENTIC_AGPL_GATEWAY_URL` in production (the existing `isPrivateUrl()` does not enforce scheme; add an explicit `https://` check except for `localhost`).
5. If `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY`, require both HMAC secrets and the gateway URL to be set.

The env-schema should mark both `*_HMAC_SECRET` vars as secret (never logged, never returned by `/health` or admin endpoints, never echoed in error messages).

---

## 3. Proposed webhook receiver route

**File:** `apps/web/src/app/api/agpl/webhooks/route.ts` (new).

Follows the existing pattern from `apps/web/src/app/api/signatures/webhook/route.ts`:

```ts
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const rawBody = await request.text(); // verify against raw bytes, not parsed JSON
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key] = value; });

  // 1. Verify HMAC signature (constant-time) using SCENTIC_AGPL_WEBHOOK_HMAC_SECRET
  //    Header: X-Gateway-Signature (sha256=<hex>)
  //    Canonical string: body\nX-Gateway-Timestamp\nX-Gateway-Nonce\nX-Gateway-Event-Id\nX-Gateway-Firm-Id\nX-Gateway-Correlation-Id
  // 2. Check timestamp tolerance (±5 min) using X-Gateway-Timestamp
  // 3. Check nonce replay (X-Gateway-Nonce) via the existing nonce store (Redis in prod)
  // 4. Verify X-Gateway-Firm-Id matches a Firm-scoped payload.scenticFirmId
  // 5. Deduplicate by Idempotency-Key (return 200 idempotent for duplicates)
  // 6. Map gateway eventType to Scentic SignatureWorkflow status update
  // 7. Map error codes to HTTP status (see §4 below)
}
```

**Key differences from `api/signatures/webhook/route.ts`:**

- **No `auth()` call.** This is a server-to-server endpoint. Authentication is HMAC-only (like the existing signature webhook route, which also calls no `auth()`).
- **Verify against the raw body**, not `request.json()`. The HMAC is computed over the exact bytes the gateway sent.
- **Use `X-Gateway-*` headers**, not the DocuSign/DocSketch headers the existing provider uses.
- **Idempotent 200 for duplicates** by `Idempotency-Key` (the existing route returns 200 for `WEBHOOK_DUPLICATE`).
- **Firm scope check:** `X-Gateway-Firm-Id` must match `payload.scenticFirmId`, and the targeted `SignatureWorkflow.firmId` must match. Reject cross-firm webhooks with `403`.

**Error code → HTTP status mapping:**

| Gateway error / condition | HTTP status |
|---------------------------|-------------|
| Missing/invalid HMAC signature | `401` |
| Stale timestamp (outside ±5 min) | `401` |
| Replayed nonce | `401` |
| Firm scope mismatch | `403` |
| Malformed payload | `400` |
| Duplicate `Idempotency-Key` (already processed) | `200` (idempotent) |
| Unknown event type | `200` (acknowledge, do not process; log) |
| Provider unavailable downstream | `503` |
| Internal error | `500` |

---

## 4. Proposed time-tracking UI/API surfaces

**Files (new):** `apps/web/src/app/api/time-entries/...`.

New Scentic API routes that proxy time-entry CRUD to the AGPL gateway. **Scentic authorization (firm/user scope) is enforced before calling the gateway** — the routes must call `auth()` and verify the caller's firm matches the `firmId` in the request before issuing a signed request to the gateway.

| Route | Method | Gateway call |
|-------|--------|--------------|
| `apps/web/src/app/api/time-entries/route.ts` | `GET` | `GET /api/v1/firms/:firmId/time-entries` (list, with filters) |
| `apps/web/src/app/api/time-entries/route.ts` | `POST` | `POST /api/v1/firms/:firmId/time-entries` (create) |
| `apps/web/src/app/api/time-entries/[id]/route.ts` | `GET` | `GET /api/v1/firms/:firmId/time-entries/:entryId` |
| `apps/web/src/app/api/time-entries/[id]/route.ts` | `PATCH` | `PATCH /api/v1/firms/:firmId/time-entries/:entryId` |
| `apps/web/src/app/api/time-entries/[id]/route.ts` | `DELETE` | `DELETE /api/v1/firms/:firmId/time-entries/:entryId` |
| `apps/web/src/app/api/time-entries/export/route.ts` | `POST` | `POST /api/v1/firms/:firmId/time-entries/export` |

**Authorization requirements:**

- Every route calls `auth()` and resolves the caller's `firmId` + `userId`.
- The `firmId` used in the gateway path MUST be the caller's firm. A request referencing another firm's entities is rejected with `403` before any gateway call.
- Time entries are scoped to the calling user unless the caller has firm-admin rights (Scentic authorization policy).
- Mapping sync (firm/user/client/matter/activity) is performed via the gateway's `/api/v1/firms/:firmId/{init,users/sync,clients/sync,matters/sync,activities/sync}` routes. Scentic may call these from admin/onboarding flows; they are not user-facing time-entry routes.

The UI surface (a time-tracking page/component) is out of scope for this spec but would consume the routes above. No dummy time entries may be seeded in production (per Scentic `AGENTS.md` product integrity rules).

---

## 5. Proposed signature provider adapter

The `AgplGatewaySignatureProvider` class (§1.2) calls these gateway endpoints. The `:firmId` is the Scentic `SignatureWorkflow.firmId`; the `:workflowId` is the value stored in `SignatureWorkflow.providerEnvelopeId`.

| Provider method | Gateway endpoint | Notes |
|-----------------|------------------|-------|
| `sendEnvelope` | `POST /api/v1/firms/:firmId/signature/workflows` | Body: `scenticSignatureWorkflowId`, `scenticDocumentId`, `documentName`, `documentBase64`, `signers[]`, `sendNow`. Returns `opensignDocumentId`, `status`. |
| `getEnvelopeStatus` | `GET /api/v1/firms/:firmId/signature/workflows/:workflowId` | Returns aggregate `status` + per-signer status. |
| `sendReminder` | `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/remind` | Gateway returns `501 NOT_SUPPORTED` (OpenSign has no manual reminder API). Provider surfaces `PROVIDER_ERROR`. |
| `cancelEnvelope` | `POST /api/v1/firms/:firmId/signature/workflows/:workflowId/cancel` | Body: `{ reason }`. Maps to OpenSign `declinedoc`. |
| `downloadSignedDocument` | `GET /api/v1/firms/:firmId/signature/workflows/:workflowId/completed` | Returns signed-PDF readiness + short-lived download URL. Provider fetches bytes within `expiresAt` and verifies sha256. |
| `verifyWebhook` | (no gateway call) | Local HMAC verification using `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET`. |

The provider signs every outbound request with `SCENTIC_AGPL_GATEWAY_HMAC_SECRET` (see `docs/SCENTIC_INTERFACE_SPEC.md` §3 for the canonical string and headers).

**Note on `delegateSigner`:** the gateway does not expose a stable delegate endpoint in AGPL-02/03 (OpenSign has no stable Cloud Function for it). The provider returns `PROVIDER_ERROR` with code `NOT_SUPPORTED`. This is a carried gap for a future AGPL phase.

---

## 6. Proposed provider health changes

### 6.1 `ProviderTypeHealth` union

**File:** `packages/ops/src/types.ts`.

Current union:

```ts
export type ProviderTypeHealth =
  | 'GOOGLE_WORKSPACE'
  | 'GOOGLE_DRIVE'
  | 'GOOGLE_ADMIN_SDK'
  | 'GOOGLE_DOCS_SHEETS'
  | 'STIRLING_PDF'
  | 'SIGNATURE_PROVIDER'
  | 'GMAIL_PROVIDER'
  | 'CALENDAR_PROVIDER'
  | 'EMAIL_DELIVERY'
  | 'OCR_SIDECAR'
  | 'AI_PROVIDER'
  | 'EXPORT_STORAGE'
  | 'BACKUP_STORAGE'
  | 'DATABASE'
  | 'REDIS_QUEUE';
```

**Proposed change:** add `'AGPL_GATEWAY'`:

```ts
  | 'REDIS_QUEUE'
  | 'AGPL_GATEWAY';
```

### 6.2 `checkProviderConfig()` case

**File:** `packages/ops/src/provider-health-service.ts` — add a `case 'AGPL_GATEWAY':` to the switch in `checkProviderConfig()`:

```ts
case 'AGPL_GATEWAY': {
  const url = process.env['SCENTIC_AGPL_GATEWAY_URL'];
  const type = (process.env['SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE'] ?? '').toUpperCase();
  const configured = !!url && type === 'AGPL_GATEWAY';
  return {
    configured,
    enabled: configured,
    healthState: configured ? 'CONFIGURED_HEALTHY' : 'NOT_CONFIGURED',
    safeMessage: configured
      ? 'AGPL gateway configured'
      : 'AGPL gateway not configured (NullSignatureProvider default)',
    technicalDetails: url ? `URL: ${url.replace(/^https?:\/\//, '***://')}` : 'No URL set',
    // RB-014 is resolved by configuring AGPL_GATEWAY as the real e-signature provider.
    productionBlocking: !configured,
  };
}
```

### 6.3 `allProviders` array

**File:** `packages/ops/src/provider-health-service.ts` — add `'AGPL_GATEWAY'` to the `allProviders` array in `getProviderHealthSummary()`:

```ts
const allProviders: ProviderTypeHealth[] = [
  'GOOGLE_WORKSPACE', 'GOOGLE_DRIVE', 'GOOGLE_ADMIN_SDK', 'GOOGLE_DOCS_SHEETS',
  'STIRLING_PDF', 'SIGNATURE_PROVIDER', 'GMAIL_PROVIDER', 'CALENDAR_PROVIDER',
  'EMAIL_DELIVERY', 'OCR_SIDECAR', 'AI_PROVIDER', 'EXPORT_STORAGE',
  'BACKUP_STORAGE', 'DATABASE', 'REDIS_QUEUE',
  'AGPL_GATEWAY',
];
```

This makes the gateway surface in Scentic's `/health` and admin UI alongside other providers.

---

## 7. Proposed audit events

**File:** `packages/db/prisma/schema.prisma` — `enum AuditEventType`.

The current `AuditEventType` enum has a single `SIGNATURE_EVENT` value for signature activity. The AGPL integration would add dedicated values so AGPL gateway operations are distinguishable in the audit log. A Prisma migration is required.

**Proposed new enum values:**

| Audit event type | When emitted |
|------------------|--------------|
| `AGPL_SIGNATURE_WORKFLOW_CREATED` | Scentic sends `POST /signature/workflows` via the provider |
| `AGPL_SIGNATURE_WORKFLOW_SENT` | Gateway confirms workflow sent to signers |
| `AGPL_SIGNATURE_WORKFLOW_COMPLETED` | Webhook `OPENSIGN_WORKFLOW_COMPLETED` processed |
| `AGPL_SIGNATURE_WORKFLOW_CANCELLED` | Scentic cancels via the provider / webhook `OPENSIGN_WORKFLOW_CANCELLED` |
| `AGPL_TIME_ENTRY_CREATED` | Time entry created via the time-tracking routes |
| `AGPL_TIME_ENTRY_UPDATED` | Time entry updated via the time-tracking routes |
| `AGPL_TIME_ENTRY_DELETED` | Time entry deleted via the time-tracking routes |

These follow the existing uppercase enum style. Audit events must never contain PDF content, signer emails in plaintext (hashed only), or the `description` text of time entries in plaintext (hashed only) — consistent with the gateway-side audit rules in `docs/API_CONTRACTS.md` §8.

> **Alternative (smaller change):** if Yair prefers not to extend the enum, the existing `SIGNATURE_EVENT` value can carry AGPL signature events with a sub-type field, and time-entry events can reuse a generic integration event. The dedicated enum values are recommended for queryability and the Scentic release-gate evidence requirements.

---

## 8. Proposed ProviderMapping usage

**Scentic's `ProviderMapping` Prisma model is NOT used for AGPL integrations.**

`ProviderMapping` (in `packages/db/prisma/schema.prisma`) maps Scentic entities to external provider IDs for providers Scentic talks to **directly** (Google Drive, Google Calendar, Gmail, e-signature providers like DocuSign). Its `providerType` field uses the `ProviderType` enum (`GOOGLE_DRIVE | GOOGLE_CALENDAR | GMAIL | E_SIGNATURE | OTHER`).

The AGPL gateway **owns its own mapping table** between Scentic entities and Kimai/OpenSign entities (Firm → Kimai team + OpenSign tenant, User → Kimai user + OpenSign user, Client → Kimai customer, Matter → Kimai project, Workflow → OpenSign document). Scentic does not need to replicate that mapping.

**What Scentic stores:**

- `SignatureWorkflow.providerType` = `AGPL_GATEWAY` (the new `SignatureProviderType` enum value).
- `SignatureWorkflow.providerEnvelopeId` = the gateway workflow id (`scenticSignatureWorkflowId`), used as the `:workflowId` in all subsequent gateway calls.
- No `ProviderMapping` rows for AGPL signature workflows.

This keeps the AGPL boundary clean: Scentic only knows "there is a workflow at the gateway with this id"; the gateway knows the Kimai/OpenSign-side ids.

---

## 9. Security review checklist

Before landing the Scentic-side changes, the following must be verified by the `security-auditor` droid (or equivalent independent reviewer). Each item is a gate, not a suggestion.

1. **HMAC verification (webhook receiver):** signature is verified in constant time (`timingSafeEqual`) against the **raw body**, not parsed JSON. Mismatch → `401`, no processing.
2. **HMAC signing (outbound requests):** every Scentic → gateway request is signed; the canonical string covers method, path, query, timestamp, nonce, body hash, firm id, user id, correlation id. Body hash for bodyless requests is `JSON.stringify({}) = '{}'` (matches gateway `extractFirmIdFromPath` + `computeBodyHash` behavior).
3. **Firm scope enforcement:** every route resolves the caller's `firmId` via `auth()` and uses it as the gateway `:firmId`. Cross-firm requests are rejected with `403` before any gateway call. Webhook `X-Gateway-Firm-Id` must match `payload.scenticFirmId` and the targeted workflow's `firmId`.
4. **Replay protection:** outbound requests include `X-Scentic-Timestamp` + `X-Scentic-Nonce`; inbound webhooks check `X-Gateway-Timestamp` (±5 min) + `X-Gateway-Nonce` (Redis-backed nonce store in production). Replayed nonce → `401`.
5. **Secret rotation:** both `SCENTIC_AGPL_GATEWAY_HMAC_SECRET` and `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET` support the gateway's dual-secret overlap window (`POST /api/v1/admin/rotate-secret`-equivalent on the Scentic side). Rotation procedure documented; 90-day cadence.
6. **Secret separation:** the gateway HMAC secret and the webhook HMAC secret are distinct values, stored in separate Secret Manager secrets, rotated independently.
7. **Network isolation:** `SCENTIC_AGPL_GATEWAY_URL` passes `isPrivateUrl()` in production (RFC 1918 / localhost / `*.local` / `*.internal`). No public URL accepted. VPC peering or Internal Load Balancer only.
8. **No secrets in logs/responses:** env-schema marks both HMAC secrets as secret; provider health surfaces only a redacted URL (`***://`); error messages never include secret material.
9. **Audit logging:** every side-effecting AGPL operation emits an audit event (§7). Audit events never contain PDF content, plaintext signer emails, or plaintext time-entry descriptions.
10. **Idempotency:** outbound writes include `Idempotency-Key`; the webhook receiver deduplicates by `Idempotency-Key` and returns `200` for duplicates.
11. **TLS:** production gateway URL is `https://` (except `localhost` for local dev). The gateway rejects plain-HTTP requests carrying a service token when `NODE_ENV=production`.
12. **Provider fail-closed:** when `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE` is unset or `NULL`, `createSignatureProvider()` returns `NullSignatureProvider` (no gateway calls, `isAvailable()` = false). Time-tracking routes return `503` when `SCENTIC_AGPL_TIME_TRACKING_ENABLED` is false.

---

## 10. Test checklist

The Scentic core changes must be covered by the following tests (in the `scentic.ai` repo). These are in addition to the gateway-side tests already in this repo.

1. **Unit tests for `AgplGatewaySignatureProvider`** (mocked gateway HTTP): all 8 interface methods; success paths + gateway error mapping (`501 NOT_SUPPORTED` → `PROVIDER_ERROR`, `502 OPENSIGN_UNREACHABLE` → `PROVIDER_UNAVAILABLE`, etc.).
2. **Env-schema validation tests:** valid/invalid `SCENTIC_AGPL_*` (placeholder secret rejected, public URL rejected, `MOCK`+`AGPL_GATEWAY` mismatch rejected, missing required vars when `AGPL_GATEWAY` selected).
3. **Webhook receiver tests:**
   - Valid HMAC accepted and workflow status updated.
   - Invalid HMAC → `401`, no processing.
   - Tampered body (one byte flipped) with old signature → `401`.
   - Missing `X-Gateway-Signature` → `401`.
   - Stale timestamp → `401`.
   - Replayed nonce → `401`.
   - Duplicate `Idempotency-Key` → `200` idempotent (processed once).
   - Firm scope mismatch (`X-Gateway-Firm-Id` ≠ payload) → `403`.
4. **Authorization tests:** a user may only act within their firm; cross-firm time-entry and signature requests rejected with `403` before any gateway call.
5. **Cross-firm isolation tests:** Firm A cannot read/modify Firm B's time entries or signature workflows through the Scentic routes (negative authorization + cross-firm leakage).
6. **Provider health tests:** `AGPL_GATEWAY` health is `CONFIGURED_HEALTHY` when URL + type set, `NOT_CONFIGURED` otherwise; gateway down propagates to `CONFIGURED_DOWN` (requires a live probe in a follow-up).
7. **End-to-end test:** Scentic → gateway → Kimai/OpenSign → webhook → Scentic status update. This is the AGPL-03 exit-criteria test and requires the gateway + Kimai + OpenSign running (local docker-compose or CI containers).

---

## 11. Release blocker impact

| Release blocker | Impact of landing the AGPL gateway provider |
|-----------------|---------------------------------------------|
| **RB-014 — Real e-signature provider** | **Resolved.** Configuring `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY` makes `SIGNATURE_PROVIDER` health report `CONFIGURED_HEALTHY` (via the new `AGPL_GATEWAY` case), satisfying RB-014's requirement for a real, non-mock e-signature provider. The OpenSign integration behind the gateway is the real provider. |
| RB-012 (Gmail), RB-013 (Calendar) | Not affected. The AGPL gateway does not provide Gmail or Calendar. |
| RB-002 (AI), RB-009 (backup), RB-015 (OCR) | Not affected. |
| Other RBs | Not directly affected. |

No other release blocker is directly resolved or worsened by the AGPL gateway provider. RB-014 is the only direct beneficiary.

> **Caveat:** RB-014 is only genuinely resolved when the AGPL stack is deployed production-ready (AGPL-04) and the Scentic-side provider has passed its E2E test against a real OpenSign instance. A documentation-only spec does not resolve RB-014; the implementation + evidence does.

---

## 12. What was NOT done

To be explicit (per the Scentic `AGENTS.md` "no false integration claims" rule):

- No Scentic core file was modified. The `scentic.ai` working tree was inspected read-only.
- No `AGPL_GATEWAY` value was added to `ProviderName`, `SignatureProviderType`, `ProviderTypeHealth`, or `AuditEventType`.
- No `AgplGatewaySignatureProvider` class was implemented.
- No `SCENTIC_AGPL_*` env vars were added to `env-schema.ts`.
- No webhook receiver route was created at `apps/web/src/app/api/agpl/webhooks/route.ts`.
- No time-entry proxy routes were created.
- No provider-health changes were applied.
- No Prisma migration was created.

All of the above are described here so Yair can decide whether and when to land them. The AGPL gateway in this repository is independently complete for AGPL-03 (local deployment + connection interface documented); the Scentic-side bridge is the consumer-side work that would follow Yair's approval.
