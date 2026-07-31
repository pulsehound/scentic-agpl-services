# Scentic Core — AGPL Gateway Environment Variables Required

> **Status:** Documentation only. No Scentic core `.env` or `env-schema.ts` file was modified. This documents the env vars Scentic core would need to add if Yair decides to integrate with the AGPL gateway.
>
> **Scope:** The Scentic-side (`scentic.ai`) env vars only. Gateway-side env vars are documented in `.env.example` and `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §4.
>
> **Related:** `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` (§2), `docs/SCENTIC_INTERFACE_SPEC.md` (§3), `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` (§3).

---

## 1. Required future Scentic env vars

These would be added to `packages/infra/src/env-schema.ts` and Scentic's deployment environment (Cloud Run env + Secret Manager). All `*_HMAC_SECRET` vars are marked secret (never logged, never returned by `/health` or admin endpoints).

| Env var | Type | Required | Production validation | Description |
|---------|------|----------|----------------------|-------------|
| `SCENTIC_AGPL_GATEWAY_URL` | string (URL) | Yes (when AGPL enabled) | Must be a private URL (`isPrivateUrl` — RFC 1918 / localhost / `*.local` / `*.internal`); require `https://` except for `localhost` | Gateway internal base URL, e.g. `https://gateway.agpl.internal`. Scentic calls this for all signature + time-tracking operations. |
| `SCENTIC_AGPL_GATEWAY_HMAC_SECRET` | string (secret) | Yes (when AGPL enabled) | Reject placeholders (`changeme`, `dev-secret`, `placeholder`, `xxx`, `test`, empty); distinct from webhook secret | Shared HMAC secret used to sign Scentic → Gateway requests (canonical string per `docs/SCENTIC_INTERFACE_SPEC.md` §3.1). |
| `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET` | string (secret) | Yes (when AGPL enabled) | Reject placeholders; distinct from gateway HMAC secret | HMAC secret used to verify Gateway → Scentic webhooks (`X-Gateway-Signature`). |
| `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE` | string | No | `AGPL_GATEWAY` or `NULL` | Set to `AGPL_GATEWAY` to enable the AGPL signature provider. Unset / `NULL` → `NullSignatureProvider`. |
| `SCENTIC_AGPL_TIME_TRACKING_ENABLED` | boolean | No | — | Enable time tracking via gateway. When `false`, time-entry routes return `503`. |

### Notes on naming

- The gateway side uses `SCENTIC_SHARED_HMAC_SECRET` (for Scentic → Gateway) and `SCENTIC_WEBHOOK_HMAC_SECRET` (for Gateway → Scentic). The Scentic side uses the `SCENTIC_AGPL_*` prefix to keep AGPL config visually distinct from other Scentic integrations. The **values must match** across the two deployments (same shared secret, same webhook secret).
- `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE` is independent of the existing `SIGNATURE_PROVIDER_TYPE`. When `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY`, the Scentic factory selects the AGPL provider; the existing `SIGNATURE_PROVIDER_TYPE` is ignored for the signature path. The env-schema must reject `MOCK` + `AGPL_GATEWAY` mismatch (§3).

---

## 2. Optional env vars

| Env var | Type | Default | Description |
|---------|------|---------|-------------|
| `SCENTIC_AGPL_GATEWAY_TIMEOUT_MS` | integer (ms) | `30000` | Per-request timeout for Scentic → Gateway calls. |
| `SCENTIC_AGPL_GATEWAY_RETRY_COUNT` | integer | `5` | Max retry attempts for retryable gateway errors (`429`, `500`, `502`, `503`). |

These do not require production validation beyond type/range checks.

---

## 3. Production validation rules

Enforced by `validateEnvironment()` in `packages/infra/src/env-schema.ts` when `NODE_ENV=production`:

1. **Reject placeholder secrets.** `SCENTIC_AGPL_GATEWAY_HMAC_SECRET` and `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET` must each be non-empty and not in the placeholder set (`changeme`, `dev-secret`, `placeholder`, `xxx`, `test`, empty).
2. **Reject public URLs.** `SCENTIC_AGPL_GATEWAY_URL` must pass `isPrivateUrl()` (RFC 1918 / localhost / `*.local` / `*.internal`). Public hostnames (e.g. `https://api.example.com`) are rejected.
3. **Reject `MOCK` + `AGPL_GATEWAY` mismatch.** If `SIGNATURE_PROVIDER_TYPE=MOCK` and `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY` (or vice versa), validation fails — only one signature provider can be active.
4. **Require HTTPS in production.** `SCENTIC_AGPL_GATEWAY_URL` must use `https://`, except `http://localhost` is permitted only when `NODE_ENV != production`. (The existing `isPrivateUrl()` does not enforce scheme; add an explicit check.)
5. **Conditional required vars.** If `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY`, then `SCENTIC_AGPL_GATEWAY_URL`, `SCENTIC_AGPL_GATEWAY_HMAC_SECRET`, and `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET` are all required.

Validation failure must prevent startup (fail-closed), consistent with the existing env-schema behavior for other providers.

---

## 4. Secret rotation guidance

- **Cadence:** rotate both `SCENTIC_AGPL_GATEWAY_HMAC_SECRET` and `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET` every **90 days** (matches the gateway-side rotation policy in `deploy/secrets.example.md`).
- **Dual-secret overlap window:** the gateway supports a dual-token overlap window (planned `POST /api/v1/admin/rotate-secret` equivalent). During rotation:
  1. Generate a new secret in Secret Manager (new version).
  2. Add the new secret to the gateway's accepted-secrets set (overlap window, default 10 minutes).
  3. Update Scentic's Secret Manager reference to the new version.
  4. Deploy/restart Scentic instances (rolling) so they pick up the new secret.
  5. After the overlap window expires, the gateway drops the old secret.
- **Rotation procedure (Scentic side):**
  1. `gcloud secrets versions create agpl-gateway-hmac-secret --data-file=-` (new version).
  2. Update the Cloud Run service to reference the new version.
  3. Verify `/health` still reports `AGPL_GATEWAY` healthy after rollout.
  4. Roll back the Secret Manager version pointer if signature verification fails.
- **Independent rotation:** the gateway HMAC secret and the webhook HMAC secret are rotated independently (different schedules acceptable). Never reuse the same value for both.
- **On compromise:** rotate immediately, revoke the old version, audit webhook receiver logs for replay attempts in the overlap window.

---

## 5. Local test config

For local development (Scentic core + gateway via `deploy/docker-compose.yml`). These values are **dev only** and must never be used in production.

| Env var | Local dev value |
|---------|-----------------|
| `SCENTIC_AGPL_GATEWAY_URL` | `http://localhost:3101` |
| `SCENTIC_AGPL_GATEWAY_HMAC_SECRET` | `dev-shared-hmac-secret` |
| `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET` | `dev-webhook-hmac-secret` |
| `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE` | `AGPL_GATEWAY` (or unset to test the disabled state) |
| `SCENTIC_AGPL_TIME_TRACKING_ENABLED` | `true` |
| `SCENTIC_AGPL_GATEWAY_TIMEOUT_MS` | `30000` |
| `SCENTIC_AGPL_GATEWAY_RETRY_COUNT` | `3` |

These match the dev defaults in `deploy/docker-compose.yml` (`SCENTIC_SERVICE_TOKEN`/`GATEWAY_WEBHOOK_SECRET` on the gateway side). The gateway's `SCENTIC_SHARED_HMAC_SECRET` must be set to the same value as Scentic's `SCENTIC_AGPL_GATEWAY_HMAC_SECRET`; the gateway's `SCENTIC_WEBHOOK_HMAC_SECRET` must match Scentic's `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET`.

---

## 6. Disabled-state behavior

When the AGPL gateway is not configured (i.e. `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE` is unset or `NULL`, or the required secrets/URL are absent):

| Surface | Behavior |
|---------|----------|
| Signature provider | `createSignatureProvider()` returns `NullSignatureProvider`. `isAvailable()` returns `false`. `sendEnvelope`/etc. return `PROVIDER_UNAVAILABLE`. |
| Time-tracking routes | Return `503 UNAVAILABLE` with a safe message ("AGPL time tracking not configured"). No gateway call is attempted. |
| Provider health | `AGPL_GATEWAY` health reports `NOT_CONFIGURED` (not `CONFIGURED_DOWN` — the gateway is intentionally absent, not down). `productionBlocking` is `true` if RB-014 depends on it. |
| Webhook receiver | The route still exists and still verifies HMAC. With no `SCENTIC_AGPL_WEBHOOK_HMAC_SECRET`, all webhooks fail signature verification (`401`). This is correct fail-closed behavior — no webhook is processed without a configured secret. |

This disabled state is the default. Scentic continues to operate without the AGPL gateway; the gateway is an opt-in integration.

---

## References

- `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` §2 — proposed env-schema changes.
- `docs/SCENTIC_INTERFACE_SPEC.md` §3 — HMAC signing rules (both directions).
- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §3 — operator-facing env var summary.
- `.env.example` — gateway-side env vars.
- `deploy/secrets.example.md` — Secret Manager naming + rotation policy.
