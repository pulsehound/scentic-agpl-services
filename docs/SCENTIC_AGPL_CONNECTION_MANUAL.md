# Scentic ↔ AGPL Gateway Connection Manual (DRAFT)

> **Status:** Draft (AGPL-00). Interfaces are defined in `docs/API_CONTRACTS.md`; the Scentic-side `AGPL_GATEWAY` provider type is not yet implemented (planned for AGPL-03).
> **Audience:** Operators integrating the Scentic core with the AGPL services stack (Kimai, OpenSign, gateway).

---

## 1. Overview

Scentic core connects to the AGPL services stack exclusively through the **AGPL gateway** — a Node.js/Express service that bridges Scentic to Kimai (time tracking) and OpenSign (e-signature). Scentic never talks to Kimai or OpenSign directly.

```
Scentic core  --(HTTPS, service token)-->  AGPL gateway  -->  Kimai REST API
                                                      -->  OpenSign Parse REST API
Scentic core  <--(webhook, HMAC)----------  AGPL gateway  <--  (OpenSign polling)
```

The gateway owns all mapping state between Scentic entities (Firms, Users, Clients, Matters) and AGPL entities (Kimai teams/users/customers/projects, OpenSign tenants/templates/envelopes).

---

## 2. Prerequisites

Before connecting, the operator must have:

1. **AGPL services deployed** — see `docs/DEPLOYMENT.md`. The gateway, Kimai, and OpenSign must be running and healthy.
2. **Gateway URL reachable from Scentic core** — internal URL via VPC peering or an Internal Load Balancer (e.g., `https://gateway.agpl.internal`).
3. **Service token generated and stored in Scentic's secret manager** — a shared secret used for service-to-service auth (`SCENTIC_AGPL_SERVICE_TOKEN`). Generated once, stored in both the gateway's secret store and Scentic's secret store.
4. **Webhook secret generated and stored in both systems** — a shared HMAC secret (`SCENTIC_AGPL_WEBHOOK_SECRET`) used by the gateway to sign webhooks sent to Scentic, and by Scentic to verify them.
5. **Gateway health verified** — `GET /health` returns `200` with `deps.kimai` and `deps.opensign` both `ok`.

---

## 3. Scentic-side env vars

Add the following to the Scentic core `.env` (values pulled from Scentic's secret manager; never committed):

| Variable | Purpose | Example |
|---|---|---|
| `SCENTIC_AGPL_GATEWAY_URL` | Base URL of the AGPL gateway, reachable from Scentic core. | `https://gateway.agpl.internal` |
| `SCENTIC_AGPL_SERVICE_TOKEN` | Service-to-service auth token sent on every request to the gateway. | `<secret>` |
| `SCENTIC_AGPL_WEBHOOK_SECRET` | HMAC secret used to verify gateway webhooks received by Scentic. | `<secret>` |
| `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE` | New Scentic `SignatureProviderType` value. Set to `AGPL_GATEWAY`. **Not yet implemented** (AGPL-03). | `AGPL_GATEWAY` |

> The `AGPL_GATEWAY` provider type is a planned Scentic core change. Until it lands, the connection can be exercised only via the gateway's own endpoints and a manual test harness (see §9).

---

## 4. AGPL gateway env vars

The canonical list is in `.env.example`. Summary:

| Variable | Purpose |
|---|---|
| `PORT` | Gateway listen port (default `8080`). |
| `SCENTIC_AGPL_SERVICE_TOKEN` | Service token the gateway expects from Scentic. |
| `SCENTIC_AGPL_WEBHOOK_SECRET` | HMAC secret the gateway uses to sign webhooks to Scentic. |
| `SCENTIC_CORE_URL` | Scentic core base URL, used to dispatch webhooks. |
| `KIMAI_BASE_URL` | Kimai base URL (e.g., `http://kimai:8001`). |
| `KIMAI_API_USER` | Kimai API username. |
| `KIMAI_API_TOKEN` (or `KIMAI_API_PASSWORD`) | Kimai API token (preferred) or password. |
| `OPENSIGN_BASE_URL` | OpenSign server base URL (e.g., `http://opensign:8081`). |
| `OPENSIGN_APP_ID` | OpenSign Parse app ID. |
| `OPENSIGN_MASTER_KEY` | OpenSign Parse master key (server-side only; never sent to Scentic). |
| `OPENSIGN_POLL_INTERVAL_MS` | Polling interval for OpenSign completion detection (default `15000`). |
| `LOG_LEVEL` | `info` / `debug` / `warn` / `error`. |

All secrets are mounted from GCloud Secret Manager in production (see `docs/DEPLOYMENT.md` §5).

### 4.1 OpenSign configuration (AGPL-02 verified)

The following gateway-side env vars configure the OpenSign integration implemented in AGPL-02. They are read by `gateway/src/config.ts` and validated in production (see `docs/DEPLOYMENT.md` for the deployment env template).

| Variable | Required? | Default | Purpose |
|---|---|---|---|
| `OPENSIGN_ENABLED` | No | `false` | Master switch for the OpenSign integration. When `false`, the OpenSign client/service are not initialized and signature routes return `503`. When `true`, production validation enforces all `OPENSIGN_*` requirements below. |
| `OPENSIGN_BASE_URL` | Yes (when enabled) | `http://localhost:8080/app` | OpenSign Parse Server REST base URL. Must be a **private network URL** in production (RFC 1918 / localhost / `*.local` / `*.internal`). The gateway appends `/functions/<name>` and `/classes/<className>`. |
| `OPENSIGN_APP_ID` | Yes (when enabled) | `opensign` | Parse `X-Parse-Application-Id` header value. |
| `OPENSIGN_MASTER_KEY` | Yes (when enabled) | (dev: `dev-master-key`) | Parse `X-Parse-Master-Key` header value. Used for all OpenSign operations in AGPL-02 (per-user session tokens are a carried gap). **Server-side only; never sent to Scentic; never logged.** Must be a strong non-placeholder value in production. |
| `OPENSIGN_ADMIN_EMAIL` | Yes (when enabled) | `admin@opensign.local` | OpenSign admin account email used by the gateway to log in and obtain a session token. |
| `OPENSIGN_ADMIN_PASSWORD` | Yes (when enabled) | (dev: `dev-password`) | OpenSign admin account password. Must be a strong non-placeholder value in production. |
| `OPENSIGN_POLL_INTERVAL_SECONDS` | No | `30` | Interval between polls of `getDocument` for active (non-terminal) workflows. Lower values reduce completion-detection latency at the cost of more upstream calls. |
| `OPENSIGN_COMPLETION_TIMEOUT_SECONDS` | No | `86400` (24h) | Maximum wall-clock time the gateway will keep polling a workflow before marking it `FAILED`/`EXPIRED` if it has not reached a terminal state. |

**Production validation (enforced by `gateway/src/config.ts` when `NODE_ENV=production` and `OPENSIGN_ENABLED=true`):**

- `OPENSIGN_BASE_URL` must be set and must be a private network URL.
- `OPENSIGN_MASTER_KEY` must be set and must not be a placeholder (`changeme`, `dev-secret`, `placeholder`, `xxx`, `test`, empty).
- `OPENSIGN_ADMIN_EMAIL` must be set.
- `OPENSIGN_ADMIN_PASSWORD` must be set and must not be a placeholder.

**OpenSign-server-side env vars** (set on the OpenSign container, not the gateway — see `docs/DEPLOYMENT.md` §3.3 and `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §6): `APP_ID`, `MASTER_KEY`, `SERVER_URL`, `MONGO_URL`, `S3_*` / `DO_*`, `MAILGUN_*` / `SMTP_*`, `PFX_CERTIFICATE` / `OPENSIGN_PFX_BASE64`, `PFX_PASSWORD` / `OPENSIGN_PASS_PHRASE`.

> Note: `OPENSIGN_POLL_INTERVAL_MS` (listed in §4 above) is the AGPL-00 planning name. AGPL-02 implements the gateway-side poll interval as `OPENSIGN_POLL_INTERVAL_SECONDS` (seconds, default 30). Use `OPENSIGN_POLL_INTERVAL_SECONDS` for the gateway; the OpenSign server itself has no poll-interval env.

---

## 5. Kimai setup steps

1. **Deploy Kimai via Docker** — see `docs/DEPLOYMENT.md` §3.2.
2. **Run the installer** — `bin/console kimai:install -n` against the Cloud SQL MySQL database (`utf8mb4`).
3. **Create the admin account** — `bin/console kimai:user:create <admin> --super-admin`, or via the Kimai UI on first run.
4. **Create teams per Firm** — In Kimai, one team per Scentic Firm. Team name should follow a stable convention (e.g., `firm:<scentic-firm-id>`). Record the Kimai team ID; the gateway stores the Scentic Firm → Kimai team mapping.
5. **Create API tokens per user** — Each Scentic user who tracks time needs a Kimai user with an API token (Kimai UI: Profile → API → Create token). Store tokens in the gateway's secret store (one secret per user, or a per-firm service token where appropriate). The gateway never exposes these tokens to Scentic.
6. **Configure CORS for the gateway origin** — Kimai API must accept requests from the gateway. If the gateway calls server-to-server (no browser), CORS is not strictly required, but set `CORS_ALLOW_ORIGIN` to the gateway host if any browser-initiated flow is used.

> Mapping storage: the gateway maintains Firm/User/Client/Matter → Kimai team/user/customer/project mappings. See `docs/API_CONTRACTS.md` for the mapping CRUD endpoints.

---

## 6. OpenSign setup steps

1. **Deploy OpenSign via Docker Compose** — see `docs/DEPLOYMENT.md` §3.3 and the local compose file in §6.
2. **Configure `APP_ID` and `MASTER_KEY`** — Set in the OpenSign container env. The `MASTER_KEY` is server-side only and must never be exposed to Scentic or any end user. Store in Secret Manager.
3. **Configure S3/GCS storage** — Point OpenSign at the GCS bucket (via S3-compatible HMAC key) or an S3 bucket. Set `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`. For local dev, use MinIO (see compose file).
4. **Configure email** — Either Mailgun (`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_FROM`) or SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`). Email is used to deliver signing links to signers.
5. **Configure the PFX certificate for PDF signing** — Provide a PFX file and password (`PFX_CERTIFICATE_PATH` / `PFX_CERTIFICATE` base64 secret, plus `PFX_PASSWORD`). This is the certificate OpenSign uses to apply the final signature/audit stamp to signed PDFs. Store the PFX as a Secret Manager secret mounted as a file.
6. **Create tenants per Firm** — One OpenSign tenant per Scentic Firm. The gateway stores the Scentic Firm → OpenSign tenant mapping. Templates and envelopes are scoped to tenants.

---

## 7. Webhook URLs

### Scentic receives webhooks from the gateway

```
POST {SCENTIC_CORE_URL}/api/agpl/webhooks/events
Headers:
  Content-Type: application/json
  X-Scentic-Webhook-Signature: sha256=<hex HMAC of the raw body, key=SCENTIC_AGPL_WEBHOOK_SECRET>
Body:
  {
    "event": "signature.completed" | "signature.declined" | "signature.expired" | ...,
    "envelope_id": "<opensign envelope id>",
    "firm_id": "<scentic firm id>",
    "matter_id": "<scentic matter id>",
    "occurred_at": "<ISO8601>"
  }
```

Scentic must:
- Verify the `X-Scentic-Webhook-Signature` header against the raw body using `SCENTIC_AGPL_WEBHOOK_SECRET`.
- Return `200` on success (and only after persisting the event idempotently).
- Return `2xx` for duplicate deliveries (idempotent).

### Gateway receives OpenSign completion callbacks

OpenSign does **not** emit native webhooks. The gateway **polls** OpenSign for envelope status changes (default every `OPENSIGN_POLL_INTERVAL_MS`, e.g., 15s) and, on a terminal state change (completed / declined / expired), dispatches a webhook to Scentic as above.

This polling gap is a known limitation (see §10).

---

## 8. Health checks

| Component | Check | Expected |
|---|---|---|
| Gateway | `GET /health` | `200 { status:"ok", deps:{ kimai:"ok", opensign:"ok" } }` |
| Scentic → Gateway | Scentic's provider-health-service calls `GET /health` and reports gateway status alongside other signature providers. | `ok` |
| Kimai | Kimai `/api/ping` (or login page 200). | 200 |
| OpenSign | Parse `/app/{APP_ID}/health` or `GET /`. | 200 |

Scentic checks gateway health via the provider health service. When `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY` is implemented (AGPL-03), the provider health service will register the gateway and surface its status in Scentic's health endpoint and admin UI.

---

## 9. Test connection steps

Run these in order after deployment:

1. **Verify service token** — from a host that can reach the gateway:
   ```bash
   curl -X POST {SCENTIC_AGPL_GATEWAY_URL}/auth/verify \
     -H "Authorization: Bearer ${SCENTIC_AGPL_SERVICE_TOKEN}"
   # Expected: 200 { "valid": true }
   ```
2. **Verify health** —
   ```bash
   curl {SCENTIC_AGPL_GATEWAY_URL}/health
   # Expected: 200 with deps.kimai=ok, deps.opensign=ok
   ```
3. **Create a test Firm mapping** —
   ```bash
   curl -X POST {SCENTIC_AGPL_GATEWAY_URL}/firms \
     -H "Authorization: Bearer ${SCENTIC_AGPL_SERVICE_TOKEN}" \
     -H "Content-Type: application/json" \
     -d '{ "scentic_firm_id": "firm-test-001", "name": "Test Firm" }'
   # Expected: 200/201 with the mapping record, including the Kimai team + OpenSign tenant created.
   ```
4. **Send a test signature workflow** —
   ```bash
   curl -X POST {SCENTIC_AGPL_GATEWAY_URL}/signatures \
     -H "Authorization: Bearer ${SCENTIC_AGPL_SERVICE_TOKEN}" \
     -H "Content-Type: application/json" \
     -d '{
       "scentic_firm_id": "firm-test-001",
       "scentic_matter_id": "matter-test-001",
       "document_name": "Test Engagement Letter",
       "document_url": "<presigned or base64 document>",
       "signers": [ { "email": "signer@example.com", "name": "Test Signer" } ]
     }'
   # Expected: 200/201 with the OpenSign envelope id and Scentic matter mapping.
   ```
5. **Confirm webhook delivery** — Complete or decline the test envelope; confirm Scentic receives the webhook at `POST /api/agpl/webhooks/events` with a valid signature and an idempotent persist.

> Until the Scentic-side `AGPL_GATEWAY` provider type exists (AGPL-03), steps 3–5 are exercised via the gateway directly and a manual webhook receiver. Once AGPL-03 lands, steps 3–5 are exercised through the Scentic signature provider interface.

---

## 10. Known disabled / deferred items

| Item | Status | Resolution phase |
|---|---|---|
| OpenSign native webhooks | **Not available.** Gateway polls OpenSign for completion. | Accepted workaround; revisit if OpenSign adds webhooks. |
| Scentic `AGPL_GATEWAY` `SignatureProviderType` | **Not yet implemented.** | AGPL-03 |
| Scentic env-schema validation for `SCENTIC_AGPL_*` | **Not yet implemented.** | AGPL-03 |
| Scentic provider-health-service entry for the gateway | **Not yet implemented.** | AGPL-03 |
| Scentic time-tracking API routes | **Not yet implemented.** | AGPL-03 |
| Production deployment | **Not yet provisioned.** | AGPL-04 |
| Source-offer endpoint live | **Not yet live.** | AGPL-05 |

---

## 11. Exact interfaces

The authoritative gateway API surface (paths, request/response schemas, error codes) is defined in:

- `docs/API_CONTRACTS.md`

This manual references those endpoints by path only; always consult `docs/API_CONTRACTS.md` for exact field names, types, and error semantics before implementing a client.

---

## References

- `docs/DEPLOYMENT.md` — AGPL services deployment.
- `docs/SOURCE_OFFER.md` — AGPL source-offer compliance.
- `docs/NEXT_STEPS.md` — implementation roadmap (AGPL-03 lands the Scentic-side changes).
- `.env.example` — gateway environment variable list.
