# Scentic ↔ AGPL Gateway Connection Manual (DRAFT)

> **Status:** Updated for AGPL-05. The gateway + Kimai + OpenSign integration is implemented and runnable locally (see §12), now backed by a **Postgres durable store** (replacing the SQLite Docker fallback) and a **mock Scentic webhook receiver** for local end-to-end webhook testing. The Scentic-side `AGPL_GATEWAY` provider type is **documentation only** (see `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`); the gateway is exercisable via its own REST surface and the bundled mock Scentic receiver. **Scentic core was not modified in any AGPL phase (AGPL-00 through AGPL-05).**
> **Audience:** Operators integrating the Scentic core with the AGPL services stack (Kimai, OpenSign, gateway).

---

## 1. Overview

Scentic core connects to the AGPL services stack exclusively through the **AGPL gateway** — a Node.js/Express service that bridges Scentic to Kimai (time tracking) and OpenSign (e-signature). Scentic never talks to Kimai or OpenSign directly.

```
Scentic core  --(HTTPS, service token)-->  AGPL gateway  -->  Kimai REST API
                                                      -->  OpenSign Parse REST API
Scentic core  <--(webhook, HMAC)----------  AGPL gateway  <--  (OpenSign polling)
                                                      |
                                                      +--> Postgres (durable store:
                                                            mappings, nonces, outbox)
```

The gateway owns all mapping state between Scentic entities (Firms, Users, Clients, Matters) and AGPL entities (Kimai teams/users/customers/projects, OpenSign tenants/templates/envelopes). As of AGPL-05, this state is persisted in a **Postgres** database (`gateway-postgres` in the Docker stack; Cloud SQL Postgres in the production manifest), replacing the in-memory/SQLite fallbacks. All store interfaces (`MappingStore`, `NonceStore`, `EventOutbox`) are now **async** (return `Promise<T>`).

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
| `GATEWAY_STORE_TYPE` | Durable store backend: `memory` / `sqlite` / `postgres`. **Docker and production use `postgres`.** `memory` is dev/tests only and rejected in production. See §13. |
| `GATEWAY_DATABASE_URL` | Postgres connection string (required when `GATEWAY_STORE_TYPE=postgres`). Format: `postgres://user:password@host:5432/gateway`. Loaded from Secret Manager in production. |
| `GATEWAY_POSTGRES_SSL_MODE` | Postgres `sslmode` (`disable` / `require` / `verify-ca` / `verify-full`). Default `disable` (acceptable only for private-IP / VPC-internal connections). Use `require` or stricter for any non-localhost connection. |
| `GATEWAY_REDIS_URL` | Optional Redis URL for nonce/idempotency store. **Not required** — Postgres provides atomic nonce/idempotency via `ON CONFLICT` (see §13.2). Left empty by default. |

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
| Gateway status | `GET /api/v1/status` | `200` with `data.stores.durable` and `data.stores.productionSuitable` booleans. `productionSuitable=true` only when `GATEWAY_STORE_TYPE=postgres`. See §13.3. |
| Scentic → Gateway | Scentic's provider-health-service calls `GET /health` and reports gateway status alongside other signature providers. | `ok` |
| Kimai | Kimai `/api/ping` (or login page 200). | 200 |
| OpenSign | Parse `/app/{APP_ID}/health` or `GET /`. | 200 |

Scentic checks gateway health via the provider health service. When `SCENTIC_AGPL_SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY` is implemented (AGPL-03 spec), the provider health service will register the gateway and surface its status in Scentic's health endpoint and admin UI.

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
5. **Confirm webhook delivery** — Complete or decline the test envelope; confirm the mock Scentic receiver (or the real Scentic webhook receiver, once implemented) receives the webhook at `POST /api/agpl/webhooks/events` with a valid signature and an idempotent persist. In the Docker stack, inspect `docker compose logs mock-scentic` for received events.

> Until the Scentic-side `AGPL_GATEWAY` provider type exists (spec in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`), steps 3–5 are exercised via the gateway directly and the bundled `mock-scentic` webhook receiver. Once the Scentic-side provider lands, steps 3–5 are exercised through the Scentic signature provider interface.

---

## 10. Known disabled / deferred items

| Item | Status | Resolution phase |
|---|---|---|
| OpenSign native webhooks | **Not available.** Gateway polls OpenSign for completion. | Accepted workaround; revisit if OpenSign adds webhooks. |
| Scentic `AGPL_GATEWAY` `SignatureProviderType` | **Not yet implemented.** | Scentic core (by Yair); spec in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`. |
| Scentic env-schema validation for `SCENTIC_AGPL_*` | **Not yet implemented.** | Scentic core (by Yair). |
| Scentic provider-health-service entry for the gateway | **Not yet implemented.** | Scentic core (by Yair). |
| Scentic time-tracking API routes | **Not yet implemented.** | Scentic core (by Yair). |
| Production deployment | **Not yet provisioned.** | Blocked on GCP project + secrets (see `docs/PRODUCTION_BLOCKERS.md`). |
| Source-offer endpoint live | **Live locally** (`GET /source`); final repo URL pending. | AGPL-05; finalize before external network use. |
| Durable store | **Delivered** — Postgres (`GATEWAY_STORE_TYPE=postgres`) is the Docker and production default. SQLite remains a bare-metal local fallback; `memory` is tests/dev only. | AGPL-05 COMPLETE. |
| Mock Scentic webhook receiver | **Delivered** — `mock-scentic` service in the Docker stack (local dev only). | AGPL-05 COMPLETE. |

---

## 11. Exact interfaces

The authoritative gateway API surface (paths, request/response schemas, error codes) is defined in:

- `docs/API_CONTRACTS.md` (planning contract surface)
- `docs/SCENTIC_INTERFACE_SPEC.md` (implemented interface: 27 Scentic→Gateway routes + 21 webhook events + HMAC rules)

This manual references those endpoints by path only; always consult `docs/SCENTIC_INTERFACE_SPEC.md` for the implemented surface and `docs/API_CONTRACTS.md` for the full planning contract before implementing a client.

---

## 12. Local deployment (AGPL-03 / AGPL-05)

This section describes how to run the full AGPL stack locally for development and connection testing. **This is not production-ready** (see §12.6). The Scentic-side provider is documentation-only (see `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`); local testing exercises the gateway directly plus the bundled mock Scentic webhook receiver (AGPL-05).

### 12.1 Architecture overview (local)

```
Scentic core (local, optional)        <-- webhook receiver (mock-scentic or future AGPL_GATEWAY provider)
  ^                                     |
  | webhook (HMAC, X-Gateway-*)         |
  |                                     v
  +--- gateway (Node/Express, :3101) ---+
        |              |              |
        v              v              v
      Kimai          OpenSign      gateway-postgres
   (Apache, :8001)  (Parse, :8080)  (Postgres 16, :5433)
        |              |              durable store: mappings,
        v              v              nonces, idempotency, outbox
   MariaDB (:3306)  MongoDB (:27017)
                     MinIO (:9000)  [OpenSign file storage]
```

Components:

- **gateway** — the AGPL bridge service (`gateway/`, Node.js/Express/TypeScript). Durable state in Postgres.
- **gateway-postgres** — Postgres 16 durable store for mapping/nonce/idempotency/outbox tables (AGPL-05; replaces the SQLite Docker fallback).
- **mock-scentic** — lightweight Node.js webhook receiver that verifies the gateway's HMAC signature, logs events, and responds `200`. **Local dev only.**
- **Kimai** — AGPL time-tracking (PHP/Symfony/Apache) + MariaDB.
- **OpenSign** — AGPL e-signature (Parse Server) + MongoDB + MinIO (S3-compatible file storage).
- **databases** — Postgres (gateway), MariaDB (Kimai), MongoDB (OpenSign) as named volumes.

### 12.2 Local deployment setup

**Prerequisites:** Docker + Docker Compose, Node 20+, pnpm.

1. **Clone and install the gateway:**
   ```bash
   git clone https://github.com/pulsehound/scentic-agpl-services
   cd scentic-agpl-services
   pnpm install
   ```
2. **Copy env templates:**
   ```bash
   cp .env.example .env
   cp deploy/env.example deploy/.env
   ```
   Edit `.env` and `deploy/.env` to set dev secrets (see `docs/SCENTIC_ENV_VARS_REQUIRED.md` §5 for the Scentic-side dev values, and the docker-compose file for the gateway-side dev defaults). The dev defaults in `deploy/docker-compose.yml` are acceptable for local use.
3. **Start the stack:**
   ```bash
   docker compose -f deploy/docker-compose.yml up -d
   ```
   This starts `gateway-postgres`, `mock-scentic`, `gateway`, Kimai, Kimai DB, OpenSign server, OpenSign frontend, MongoDB, and MailHog. The gateway uses `GATEWAY_STORE_TYPE=postgres` and waits for `gateway-postgres` to be healthy before booting.
4. **Startup order** is enforced by `depends_on` in the compose file:
   - `kimai-db` → `kimai`
   - `opensign-mongo` → `opensign-server` → `opensign-frontend`
   - `gateway-postgres` (healthy) + `mock-scentic` + `kimai` + `opensign-server` → `gateway`
5. **Initialize Kimai** (first run only):
   ```bash
   docker compose -f deploy/docker-compose.yml exec kimai bin/console kimai:install -n
   docker compose -f deploy/docker-compose.yml exec kimai bin/console kimai:user:create susan_super --super-admin
   ```
   Then create a Kimai API token via the UI (Profile → API) and set `KIMAI_ADMIN_API_TOKEN` in `.env`.
6. **Verify OpenSign** is reachable at `http://localhost:8080/app` and the frontend at `http://localhost:3000`.

### 12.3 Health check commands

```bash
# Gateway health (no auth)
curl http://localhost:3101/health
# Expected: 200 with deps.kimai + deps.opensign reachable

# Gateway status (shows stores.durable + stores.productionSuitable)
curl http://localhost:3101/api/v1/status
# Expected: stores.mapping=postgres, stores.durable=true, stores.productionSuitable=true

# Mock Scentic webhook receiver health
curl http://localhost:3199/health
# Expected: 200 (mock receiver ready; logs received webhook events to stdout)

# Gateway Postgres (durable store) health
docker compose -f deploy/docker-compose.yml exec gateway-postgres pg_isready -U gateway
# Expected: /var/run/postgresql:5432 - accepting connections

# Kimai provider health (HMAC required — use the gateway test helper or signed curl)
curl http://localhost:3101/api/v1/providers/kimai/health \
  -H "X-Scentic-Timestamp: $(date +%s)000" \
  -H "X-Scentic-Nonce: $(uuidgen)" \
  -H "X-Scentic-Firm-Id: firm-test-001" \
  -H "X-Scentic-Signature: <computed-hmac>"

# OpenSign provider health (HMAC required)
curl http://localhost:3101/api/v1/providers/opensign/health
```

For HMAC-signed requests, use the gateway's test helper utilities (`gateway/src/auth/hmac.ts` exports `computeSignature`) or the contract test scripts in `scripts/`.

### 12.4 Contract test commands

```bash
# Gateway unit + integration tests (Vitest)
pnpm --filter gateway test

# Typecheck
pnpm --filter gateway typecheck

# Build
pnpm --filter gateway build

# Run the webhook dispatcher smoke test (if configured)
pnpm --filter gateway test:run -- src/tests/webhook-dispatcher.test.ts
```

Real-Kimai / real-OpenSign container contract tests are a carried gap (mock-only in AGPL-01/02/03); they must land before production readiness (see `docs/PRODUCTION_BLOCKERS.md`).

### 12.5 Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `GET /health` returns `deps.kimai=down` | Kimai not yet installed or DB not ready | Run `kimai:install -n`; wait for `kimai-db` healthcheck; verify `DATABASE_URL`. |
| `GET /health` returns `deps.opensign=down` | OpenSign server still booting or MongoDB not ready | Wait for `opensign-mongo` + `opensign-server` healthchecks; check `MONGODB_URI`. |
| `401 UNAUTHORIZED` on signed requests | Wrong HMAC secret, stale timestamp, or wrong canonical string | Confirm `SCENTIC_SHARED_HMAC_SECRET` matches between Scentic/dev caller and gateway; check clock skew (±5 min); verify the canonical string per `docs/SCENTIC_INTERFACE_SPEC.md` §3.1. For bodyless requests, ensure body hash = `JSON.stringify({}) = '{}'`. |
| `503 UNAVAILABLE` on signature routes | `OPENSIGN_ENABLED=false` | Set `OPENSIGN_ENABLED=true` and provide `OPENSIGN_MASTER_KEY`/`OPENSIGN_ADMIN_PASSWORD`. |
| `501 NOT_SUPPORTED` on `/remind` | OpenSign has no manual reminder API | Expected; use automatic per-doc reminders (`AutomaticReminders`). |
| Webhook not delivered | `SCENTIC_WEBHOOK_TARGET_URL` or `SCENTIC_WEBHOOK_HMAC_SECRET` unset on gateway | Set both in `deploy/.env`; the dispatcher is disabled when either is missing. In the Docker stack the target is `http://mock-scentic:3199/webhook`. |
| Gateway fails to boot: `GATEWAY_STORE_TYPE=postgres requires GATEWAY_DATABASE_URL` | Postgres selected but no connection string | Set `GATEWAY_DATABASE_URL` (the Docker stack default is `postgres://gateway@gateway-postgres:5432/gateway`). |
| Gateway fails to boot: connection refused to `gateway-postgres:5432` | Postgres container not yet healthy | Wait for the `gateway-postgres` healthcheck; the gateway `depends_on` gate should prevent this, but a slow host may need `start_period` raised. |
| Mock Scentic receiver not receiving webhooks | `mock-scentic` not started or secret mismatch | Verify `docker compose ps mock-scentic` is healthy; confirm `SCENTIC_WEBHOOK_HMAC_SECRET` matches between `gateway` and `mock-scentic` (both read `${SCENTIC_WEBHOOK_HMAC_SECRET:-dev-webhook-hmac-secret}`). |
| Port conflict on 3101/3199/5433/8001/8080/3000 | Another process using the port | Change the host port mapping in `deploy/docker-compose.yml`. |

### 12.6 What is NOT production-ready

The local deployment is for development and connection testing only. The following are **not** production-ready:

- **Docker store is durable but not production-hardened:** the Docker stack uses Postgres (`gateway-postgres`) with a local volume, so mapping/nonce/outbox state survives gateway restarts. However the volume is local (no backup/restore tested), dev credentials are placeholders, and no HA/replication is configured. Production uses Cloud SQL Postgres (see §13 and `deploy/gcloud/`).
- **`memory` store (when explicitly selected):** `GATEWAY_STORE_TYPE=memory` uses in-memory mapping/nonce/idempotency stores; a process restart loses all state. Rejected in production by `store-factory.ts`. Suitable only for unit/integration tests.
- **`sqlite` store (bare-metal local only):** `GATEWAY_STORE_TYPE=sqlite` is a single-instance file-backed store. It is **not used in the Docker stack** (better-sqlite3 native module segfaults in the Alpine container) and is rejected in production unless `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=true`. Use it only for bare-metal local dev outside Docker.
- **Dev secrets:** the docker-compose dev defaults (`dev-master-key`, `dev-token`, `dev-webhook-secret`) are placeholders. Production requires strong secrets from Secret Manager (see `docs/SCENTIC_ENV_VARS_REQUIRED.md` §3).
- **Mock-only upstream tests:** no real-Kimai or real-OpenSign container contract test exists yet (carried gap; see `docs/PRODUCTION_BLOCKERS.md`).
- **Per-user upstream tokens:** the gateway uses `KIMAI_ADMIN_API_TOKEN` and the OpenSign master key for all operations. Per-user tokens are a carried gap.
- **No TLS:** local uses plain HTTP. Production requires TLS (VPC peering + Internal Load Balancer, or Cloud Run `--ingress=internal`).
- **No persistence/backup guarantees:** the Docker Postgres volume is local; no backup/restore tested. Cloud SQL backups are documented but not provisioned.
- **No monitoring/alerting:** local has no uptime checks or dashboards.
- **Mock Scentic receiver:** the `mock-scentic` service is a **local dev harness only** — it logs events and returns `200` but does not persist them or update Scentic workflow state. The real Scentic-side webhook receiver is documentation-only (see `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` §3).

### 12.7 How to keep Scentic proprietary core separate

The AGPL boundary is enforced by repo + network isolation, not by code sharing:

1. **Separate repositories.** Scentic core lives in `scentic.ai` (proprietary); the AGPL stack lives in `scentic-agpl-services` (AGPL-3.0). No `@scentic/*` package is imported into the gateway (verified by the `no-@scentic-imports` scan in `gateway/src/tests/docs-scans.test.ts`).
2. **API-only integration.** Scentic core talks to the gateway exclusively over REST + webhooks. No AGPL source is copied into Scentic core. The Scentic-side `AgplGatewaySignatureProvider` (proposed, documentation-only) is a proprietary client that calls the gateway's HTTP API — it does not import gateway code.
3. **Network isolation.** In production the gateway is internal-only (Cloud Run `--ingress=internal` or an Internal Load Balancer). Scentic reaches it via VPC peering, never over the public internet. `SCENTIC_AGPL_GATEWAY_URL` must pass `isPrivateUrl()`.
4. **No shared secrets across the boundary.** The HMAC and webhook secrets are shared values, but they are not Scentic proprietary data — they are integration credentials stored in both systems' Secret Managers independently.
5. **Source-offer compliance.** The AGPL repo's `docs/SOURCE_OFFER.md` and `GET /source-offer` satisfy AGPL-3.0 Section 13 for the gateway + Kimai + OpenSign. Scentic proprietary core is explicitly excluded from the source offer.
6. **License scan gate.** The repo scans for any `@scentic/*` import or proprietary path reference in tracked files and fails CI on a match (AGPL-05 scope; partial checks already in `gateway/src/tests/docs-scans.test.ts`).

For the full separation policy, see `docs/SOURCE_OFFER.md`.

---

## 13. Postgres durable store (AGPL-05)

AGPL-05 replaced the Docker SQLite fallback with a **Postgres** durable store. The `pg` driver is pure JavaScript (no native build tools), which also resolved the `better-sqlite3` segfault that prevented SQLite from running inside the Alpine-based gateway container. The Docker stack now uses Postgres by default; the production manifest targets Cloud SQL Postgres.

### 13.1 Configuration

| Env var | Required | Default (Docker) | Purpose |
|---|---|---|---|
| `GATEWAY_STORE_TYPE` | Yes | `postgres` | Selects the store backend. `postgres` for Docker/production; `memory` for tests; `sqlite` for bare-metal local only. |
| `GATEWAY_DATABASE_URL` | Yes (when `postgres`) | `postgres://gateway@gateway-postgres:5432/gateway` | Postgres connection string. Production value comes from Secret Manager. |
| `GATEWAY_POSTGRES_SSL_MODE` | No | `disable` | `sslmode` for the `pg` connection. Use `require`+ for any non-localhost/non-private-IP connection. |
| `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION` | No | `false` | Escape hatch to allow SQLite in production (single-instance only; **not recommended**). |

The store factory (`gateway/src/storage/store-factory.ts`) is **async** (`createStoreBundle` returns `Promise<StoreBundle>`). In production it rejects `memory` outright and rejects `sqlite` unless the escape hatch is set. The Postgres adapter (`gateway/src/storage/postgres-store.ts`) runs `postgres-schema.sql` on boot to create the 13 tables if absent.

### 13.2 Multi-instance safety

Postgres enables safe horizontal scaling of the gateway (multiple Cloud Run instances sharing one Cloud SQL database):

- **Nonces** (`nonces` table): atomic replay prevention via `INSERT ... ON CONFLICT (nonce) DO NOTHING`. Two concurrent instances cannot accept the same nonce.
- **Idempotency keys** (`idempotency_keys` table): atomic duplicate prevention via `INSERT ... ON CONFLICT (key) DO NOTHING`/`DO UPDATE`. A retried write is served from the cached response row, not re-executed upstream.
- **Outbox** (`outbox_events` table): safe concurrent processing via `SELECT ... FOR UPDATE SKIP LOCKED`. Multiple gateway instances can poll the outbox without double-dispatching the same webhook event.
- **Mappings**: `UNIQUE` constraints on `(scentic_firm_id, scentic_entity_id)` prevent duplicate mappings across instances.

Redis is **optional** — Postgres alone provides all the atomic primitives required for multi-instance operation. `GATEWAY_REDIS_URL` is left empty by default.

### 13.3 Status endpoint

`GET /api/v1/status` reports the store backend and durability flags:

```json
"stores": {
  "mapping": "postgres",
  "nonce": "postgres",
  "outbox": "postgres",
  "durable": true,
  "productionSuitable": true
}
```

`durable` is `true` for `sqlite` and `postgres`; `productionSuitable` is `true` **only** for `postgres`. The `warnings` array flags any non-Postgres backend; the `blockers` array lists remaining production blockers (real upstream contract tests, PFX cert, GCP provisioning, Scentic core integration).

### 13.4 What is stored (and what is not)

The Postgres schema (`gateway/src/storage/postgres-schema.sql`) stores only operational mapping and coordination state — **never** document contents, raw signer emails, or secrets:

| Stored | Not stored |
|---|---|
| Scentic ↔ Kimai/OpenSign id mappings (firm, user, client, matter, activity, time entry, workflow, signer) | PDF bytes / document contents |
| Outbox event metadata + `JSONB payload` (event type, ids, `safeSummary`) | Raw signer emails (only `signer_email_hash` is persisted) |
| Nonces, idempotency keys + cached response bodies | HMAC secrets, upstream API tokens, master keys |
| `TIMESTAMPTZ` created/updated timestamps | Confidential matter names beyond the sanitized `display_label_used` |

All tables are **Firm-scoped** (`scentic_firm_id` column) with `UNIQUE` constraints, preserving the cross-firm leakage prevention invariants from AGPL-01/02.

### 13.5 Scentic core was not modified

AGPL-05, like all prior phases, did **not** modify the Scentic core repository (`scentic.ai`). The Postgres store is gateway-internal; Scentic core continues to see the same REST + webhook interface documented in `docs/SCENTIC_INTERFACE_SPEC.md`. The only Scentic-visible change is that the gateway's status endpoint now reports `durable`/`productionSuitable`, and webhook events are persisted in a Postgres outbox (so delivery survives gateway restarts). The Scentic-side webhook receiver still needs to be implemented by Yair (see `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` §3).

---

## References

- `docs/DEPLOYMENT.md` — AGPL services deployment (production + local).
- `docs/SOURCE_OFFER.md` — AGPL source-offer compliance.
- `docs/NEXT_STEPS.md` — implementation roadmap (AGPL-05 is the final phase).
- `docs/SCENTIC_INTERFACE_SPEC.md` — implemented interface (27 routes + 21 webhooks).
- `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` — Scentic-side changes (documentation only).
- `docs/SCENTIC_ENV_VARS_REQUIRED.md` — Scentic-side + gateway-side env vars.
- `docs/SECURITY_THREAT_MODEL.md` — threat model (incl. Postgres storage section, AGPL-05).
- `docs/AGPL_DEPLOYMENT_HANDOFF.md` — final deployment handoff.
- `docs/FINAL_OPERATOR_CHECKLIST.md` — operator checklist.
- `docs/PRODUCTION_BLOCKERS.md` — production blockers.
- `.env.example` — gateway environment variable list.
- `gateway/src/storage/postgres-store.ts` — PostgresMappingStore implementation.
- `gateway/src/storage/postgres-schema.sql` — Postgres DDL (13 tables).
- `gateway/src/storage/store-factory.ts` — async store factory (memory/sqlite/postgres).
- `deploy/docker-compose.yml` — local docker-compose stack (Postgres default).
- `deploy/mock-scentic.js` + `deploy/Dockerfile.mock-scentic` — mock webhook receiver.
