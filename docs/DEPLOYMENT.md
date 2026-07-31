# AGPL Services Deployment Plan

> **Status:** Planning document (AGPL-00) + local deployment verified (AGPL-03) + Postgres durable store delivered (AGPL-05). No production deployment executed. The local docker-compose stack is runnable and uses Postgres by default; production GCP deployment is documented via manifests but not provisioned.
> **Scope:** Deployment of the Scentic AGPL services stack — Kimai, OpenSign, and the Scentic↔AGPL gateway — on Google Cloud Platform (GCP), plus local development deployment.
> **Out of scope:** Scentic proprietary core (already deployed in its own GCP project; not modified in any AGPL phase).

---

## 1. Recommended option — Option B: Separate GCP project for AGPL services

### Decision

Deploy all AGPL-licensed services into a **new, dedicated GCP project** (working name: `scentic-agpl-prod`). The Scentic proprietary core remains in its existing GCP project unchanged.

### Rationale

| Concern | Benefit of a separate project |
|---|---|
| **Licensing separation** | AGPL workloads and their dependencies are isolated from proprietary code, making source-offer scope and license-audit boundaries unambiguous. |
| **Service accounts** | AGPL services run under dedicated least-privilege service accounts that have no access to Scentic core resources. |
| **Billing** | AGPL cost lines (Kimai, OpenSign, gateway, Cloud SQL, GCS, egress) are reported on a separate billing account, simplifying cost attribution and source-offer cost reporting. |
| **IAM** | Access policies for AGPL services do not grant any principal access to Scentic core projects, and vice versa. Reduces blast radius of misconfiguration. |
| **Quota & limits** | AGPL workloads have their own compute/Cloud SQL/Cloud Run quotas, preventing contention with the Scentic core. |
| **Audit & logging** | Cloud Audit Logs and Cloud Logging are scoped per project, so AGPL activity can be audited independently. |

### What stays where

- **Scentic core (existing project):** Unchanged. Continues running on Cloud Run or GCE as today.
- **AGPL services (new project `scentic-agpl-prod`):**
  - Gateway (Node.js/Express)
  - Kimai (PHP/Symfony) + Cloud SQL for MySQL
  - OpenSign (Node.js/Parse Server) + MongoDB + GCS object storage

---

## 2. Architecture diagram

```
                ┌──────────────────────────────────────────────────────────────┐
                │  GCP Project: scentic-core-prod  (existing, unchanged)       │
                │                                                              │
                │   ┌────────────────────────────────┐                         │
                │   │  Scentic Core                  │                         │
                │   │  (Cloud Run or GCE)            │                         │
                │   │  - Proprietary services        │                         │
                │   │  - Calls gateway over internal │                         │
                │   │    IP / VPC peering            │                         │
                │   └───────────────┬────────────────┘                         │
                └───────────────────┼──────────────────────────────────────────┘
                                    │  HTTPS (internal)
                                    │  Service token (SCENTIC_AGPL_SERVICE_TOKEN)
                                    │  VPC peering  or  Internal Load Balancer
                                    ▼
                ┌──────────────────────────────────────────────────────────────┐
                │  GCP Project: scentic-agpl-prod  (new)                       │
                │                                                              │
                │   ┌────────────────────────────────┐                         │
                │   │  AGPL Gateway                  │                         │
                │   │  (Cloud Run, internal-only)    │                         │
                │   │  Node.js / Express             │                         │
                │   │  Durable store: Cloud SQL      │                         │
                │   │     Postgres (mappings,        │                         │
                │   │     nonces, idempotency,       │                         │
                │   │     outbox)                    │                         │
                │   │  GET  /health                  │                         │
                │   │  GET  /source-offer            │                         │
                │   │  POST /auth/verify             │                         │
                │   │  /firms /users /clients        │                         │
                │   │  /matters /time /signatures    │                         │
                │   └───┬──────────────────────┬─────┘                         │
                │       │                      │                              │
                │       ▼                      ▼                              │
                │   ┌─────────────┐      ┌──────────────────┐                 │
                │   │  Kimai      │      │  OpenSign Server │                 │
                │   │  (Cloud Run │      │  (Cloud Run or   │                 │
                │   │   or GCE)   │      │   GCE)           │                 │
                │   │  PHP-FPM /  │      │  Node.js /       │                 │
                │   │  Apache     │      │  Parse Server    │                 │
                │   │  :public    │      │  :internal       │                 │
                │   │             │      │  polls OpenSign  │                 │
                │   └──────┬──────┘      └────┬──────────┬──┘                 │
                │          │                  │          │                    │
                │          ▼                  ▼          ▼                    │
                │   ┌─────────────┐    ┌──────────┐  ┌────────────┐           │
                │   │ Cloud SQL   │    │ MongoDB  │  │  GCS       │           │
                │   │ MySQL 8     │    │ (Atlas   │  │  Bucket    │           │
                │   │ utf8mb4     │    │  or GCE  │  │  (OpenSign │           │
                │   │ (Kimai)     │    │  self-   │  │   files /  │           │
                │   │             │    │  hosted) │  │   PDFs)    │           │
                │   └─────────────┘    └──────────┘  └────────────┘           │
                │                                                              │
                │   ┌─────────────────────────────────────────┐                │
                │   │ Cloud SQL Postgres 15/16 (gateway store)│                │
                │   │ private IP, regional HA                 │                │
                │   │ tables: mappings, nonces,               │                │
                │   │   idempotency_keys, outbox_events       │                │
                │   └─────────────────────────────────────────┘                │
                │                                                              │
                │   Secrets: Cloud Secret Manager  (per-service secrets)       │
                │   Logging: Cloud Logging                                       │
                │   Monitoring: Cloud Monitoring + Uptime checks                │
                └──────────────────────────────────────────────────────────────┘
```

### Communication paths

- **Scentic core → Gateway:** HTTPS over VPC peering or an Internal Load Balancer. Authenticated with a shared service token.
- **Gateway → Kimai:** HTTPS to Kimai REST API (`/api`).
- **Gateway → OpenSign:** HTTPS to Parse Server REST API (`/app/{APP_ID}`).
- **OpenSign → GCS:** S3-compatible API or GCS SDK for file/PDF storage.
- **OpenSign signing pages → end users:** Public HTTPS (the only public endpoint from this stack besides the Kimai UI).
- **Kimai UI → time trackers:** Public HTTPS (only if external time trackers need browser access; otherwise internal-only).

---

## 3. Service-by-service deployment

### 3.1 Gateway — Cloud Run (managed, internal-only)

- **Runtime:** Node.js 20.
- **Image:** Built from `deploy/Dockerfile.gateway` (AGPL-05 simplified: pure-JS `pg` driver, no native build toolchain), pushed to Artifact Registry in `scentic-agpl-prod`.
- **Compute:** Cloud Run service with `--ingress=internal` (and `--ingress=internal-and-cloud-latency-balancing` if fronted by an Internal Load Balancer).
- **Scaling:** Min instances 1 (avoid cold starts on internal calls), max instances configurable. Can scale to zero if cost-sensitive and cold starts are acceptable. **Multi-instance safe** with the Postgres store (atomic nonce/idempotency/outbox ops — see §3.5).
- **Durable store:** Postgres (Cloud SQL). The gateway persists mapping, nonce, idempotency, and outbox state in Postgres (`GATEWAY_STORE_TYPE=postgres`). `memory` is rejected in production; `sqlite` is rejected unless `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=true` (single-instance only, not recommended). See §3.5.
- **Secrets:** Mounted from Secret Manager via Cloud Run secret volume mounts.
- **Env:** See `.env.example` for the canonical variable list.

### 3.2 Kimai — Cloud Run or GCE with Cloud SQL for MySQL

- **Runtime:** PHP 8.2+ with Apache (`kimai/kimai2:apache`) or PHP-FPM (`kimai/kimai2:fpm`).
- **Compute options:**
  - **Cloud Run:** Use `kimai/kimai2:apache` (or fpm + a small nginx sidecar). Stateless file layer via a mounted volume or GCS Fuse for `var/`. Good for autoscaling.
  - **GCE (recommended for predictable load / persistent `var/`):** Single managed instance group with a persistent disk for `var/`. Simpler storage story.
- **Database:** Cloud SQL for MySQL 8 (or 8.4), `utf8mb4` charset, `utf8mb4_unicode_ci` collation. Private IP in the AGPL VPC. High availability (regional) for production.
- **Kimai env:** `DATABASE_URL=mysql://kimai:<secret>@<cloudsql-private-ip>:3306/kimai?charset=utf8mb4`.
- **Kimai API:** Enabled via Kimai admin (System → API). API tokens per user.
- **Public exposure:** Kimai UI exposed only if external time trackers need it; otherwise internal-only behind the gateway.

### 3.3 OpenSign — Cloud Run or GCE with MongoDB Atlas

- **Runtime:** Node.js 18/20/22 (Parse Server).
- **Compute options:**
  - **Cloud Run:** Stateless container; works because OpenSign delegates storage to MongoDB + object storage.
  - **GCE:** For long-running polling and stable connections to MongoDB.
- **Database:** MongoDB Atlas (M10+ recommended for production) in a region near `scentic-agpl-prod`, peered to the AGPL VPC. Alternatively, self-hosted MongoDB on GCE (higher ops burden; only if Atlas is not acceptable).
- **Storage:** GCS bucket via S3-compatible API (OpenSign supports `s3` adapter pointed at GCS with an HMAC key) or via the GCS SDK.
- **Mail:** Mailgun or SMTP (e.g., Google Workspace SMTP relay, or a transactional provider). Credentials in Secret Manager.
- **PDF signing:** PFX certificate stored as a Secret Manager secret, mounted as a file into the container.
- **Env:** `APP_ID`, `MASTER_KEY`, `SERVER_URL`, `MONGO_URL`, `S3_*` / `GCS_*`, `MAILGUN_*` / `SMTP_*`, `PFX_*` — see `.env.example`.

### 3.4 Storage — GCS bucket for OpenSign file storage

- **Bucket:** `scentic-agpl-opensign-files-<env>` in `scentic-agpl-prod`.
- **Access:** Uniform bucket-level access. HMAC key (interoperability) for the S3-compatible adapter, or a service account for the GCS SDK.
- **Lifecycle:** Noncurrent versions + age-based transitions to Nearline/Coldline for completed envelopes after a retention threshold.
- **Encryption:** CMEK recommended for production.
- **Backup:** Object Versioning on the bucket + a weekly `gsutil rsync` to a secondary bucket in a different region for DR.

### 3.5 Gateway durable store — Cloud SQL Postgres (AGPL-05)

The gateway's mapping/nonce/idempotency/outbox state is persisted in **Postgres** (Cloud SQL Postgres in production; `gateway-postgres` in the local Docker stack). AGPL-05 replaced the SQLite Docker fallback with the pure-JavaScript `pg` driver, which both resolved the `better-sqlite3` native-module segfault in Alpine containers and enabled multi-instance operation.

- **Instance:** Cloud SQL Postgres 15 (or 16), private IP in the AGPL VPC, regional HA for production. See `deploy/gcloud/deploy-commands.md` §5 for provisioning commands.
- **Database:** `gateway` database + `gateway` user. Schema is auto-created on boot via `gateway/src/storage/postgres-schema.sql` (13 tables, `TIMESTAMPTZ`, `JSONB` outbox payload).
- **Connection string:** `GATEWAY_DATABASE_URL=postgres://gateway:<password>@<cloud-sql-private-ip>:5432/gateway`. Password sourced from Secret Manager (`GATEWAY_DATABASE_URL` secret — see §5 and `deploy/secrets.example.md`).
- **SSL:** `GATEWAY_POSTGRES_SSL_MODE`. `disable` is acceptable only for private-IP/VPC-internal connections; use `require` or stricter otherwise.
- **Store backend selection:** `GATEWAY_STORE_TYPE=postgres` (Docker + production default). `memory` is rejected in production by `store-factory.ts`; `sqlite` is rejected unless `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=true` (single-instance, not recommended).
- **Multi-instance safety:** atomic nonce prevention (`ON CONFLICT DO NOTHING`), atomic idempotency (`ON CONFLICT`), and safe concurrent outbox processing (`FOR UPDATE SKIP LOCKED`). Redis is optional (`GATEWAY_REDIS_URL` left empty by default).
- **What is stored:** Scentic↔Kimai/OpenSign id mappings (firm/user/client/matter/activity/time-entry/workflow/signer), outbox event metadata + `JSONB` payload, nonces, idempotency keys + cached responses, `TIMESTAMPTZ` timestamps. All tables Firm-scoped (`scentic_firm_id`) with `UNIQUE` constraints.
- **What is NOT stored:** document/PDF contents, raw signer emails (only `signer_email_hash`), HMAC secrets, upstream API tokens, master keys.

The store factory (`gateway/src/storage/store-factory.ts`) is **async**; `createStoreBundle` returns `Promise<StoreBundle>`. The Postgres adapter is `gateway/src/storage/postgres-store.ts`.

---

## 4. Networking

### VPC and peering

- Each GCP project has its own VPC. Peer the Scentic core VPC with the AGPL VPC so the Scentic core can reach the gateway's internal IP.
- Alternatively, expose the gateway via an **Internal Load Balancer** in the AGPL VPC and reach it through VPC peering (recommended for a stable internal hostname).

### Egress / public exposure

- **Internal-only (no public endpoint):**
  - Gateway
  - OpenSign server (Parse API)
  - Cloud SQL, MongoDB, GCS
- **Public (only where required):**
  - **Kimai UI** — only if external time trackers need browser access. Lock down with Identity-Aware Proxy (IAP) where possible.
  - **OpenSign signing pages** — public-facing end-user signing URLs. Fronted by Cloud Load Balancing with HTTPS + a managed certificate. Consider IAP-protected admin paths.

### Firewall / ingress

- Cloud Run services use `--ingress=internal` (or `internal-and-cloud-load-balancing`).
- GCE instances use VPC firewall rules restricting SSH (IAP TCP forwarding only) and service ports to the peered subnet CIDR.

### DNS

- Internal DNS via Cloud DNS private zone (e.g., `agpl.internal`) for the gateway, Kimai API, and OpenSign API.
- Public DNS for any public-facing signing pages and (optionally) the Kimai UI.

---

## 5. Secrets management

- **Store:** Google Cloud Secret Manager in `scentic-agpl-prod`.
- **Per-service secrets** (separate secret per service, least privilege):
  - `gateway-SCENTIC_AGPL_SERVICE_TOKEN`
  - `gateway-SCENTIC_AGPL_WEBHOOK_SECRET`
  - `gateway-KIMAI_BASE_URL`, `gateway-KIMAI_API_TOKEN_*`
  - `gateway-OPENSIGN_BASE_URL`, `gateway-OPENSIGN_APP_ID`, `gateway-OPENSIGN_MASTER_KEY`
  - `gateway-GATEWAY_DATABASE_URL` (Cloud SQL Postgres connection string for the durable store; AGPL-05)
  - `kimai-DATABASE_URL`
  - `opensign-APP_ID`, `opensign-MASTER_KEY`, `opensign-MONGO_URL`
  - `opensign-S3_ACCESS_KEY`, `opensign-S3_SECRET_KEY`
  - `opensign-MAILGUN_API_KEY` (or `opensign-SMTP_PASSWORD`)
  - `opensign-PFX_CERTIFICATE` (PFX file, base64) + `opensign-PFX_PASSWORD`
- **Access:** Each service's runtime service account is granted `roles/secretmanager.secretAccessor` only on its own secrets.
- **Rotation:** Document per-secret rotation procedures; service tokens and API tokens rotated at least every 90 days.
- **Hard rules:**
  - No secrets in the repository.
  - No secrets in `.env` files committed to git (only `.env.example` with placeholders).
  - No secrets baked into container images.

### 5.1 OpenSign gateway env vars (AGPL-02)

The gateway reads the following OpenSign env vars (validated by `gateway/src/config.ts` when `OPENSIGN_ENABLED=true` in production). Add these to the gateway's Cloud Run env template, sourcing secrets from Secret Manager:

| Variable | Source | Notes |
|---|---|---|
| `OPENSIGN_ENABLED` | plain env | `true` to enable the OpenSign integration. When `false`, signature routes return `503`. |
| `OPENSIGN_BASE_URL` | plain env | OpenSign Parse REST base URL, e.g. `http://opensign.internal:8081/app`. **Must be a private network URL in production.** |
| `OPENSIGN_APP_ID` | plain env or Secret Manager | Parse `X-Parse-Application-Id`. Not secret, but managed. |
| `OPENSIGN_MASTER_KEY` | **Secret Manager** (`agpl-opensign-master-key`) | Parse `X-Parse-Master-Key`. Strong, non-placeholder. Used for all OpenSign operations in AGPL-02. |
| `OPENSIGN_ADMIN_EMAIL` | plain env | OpenSign admin account email used by the gateway to log in. |
| `OPENSIGN_ADMIN_PASSWORD` | **Secret Manager** (`agpl-opensign-admin-password`) | OpenSign admin account password. Strong, non-placeholder. |
| `OPENSIGN_POLL_INTERVAL_SECONDS` | plain env | Poll interval for `getDocument` (default `30`). |
| `OPENSIGN_COMPLETION_TIMEOUT_SECONDS` | plain env | Max poll duration before a workflow is marked failed/expired (default `86400`). |

**OpenSign-server-side env vars** (set on the OpenSign container, not the gateway): `APP_ID`, `MASTER_KEY`, `SERVER_URL`, `MONGO_URL`, `S3_*` / `DO_*`, `MAILGUN_*` / `SMTP_*`, `OPENSIGN_PFX_BASE64`, `OPENSIGN_PASS_PHRASE`. See §3.3 and `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §6.

### 5.2 Production validation

When `NODE_ENV=production` and `OPENSIGN_ENABLED=true`, `gateway/src/config.ts` rejects the deployment if any of the following are missing or placeholder: `OPENSIGN_BASE_URL` (must be private), `OPENSIGN_MASTER_KEY`, `OPENSIGN_ADMIN_EMAIL`, `OPENSIGN_ADMIN_PASSWORD`. The gateway will fail to start rather than run with weak OpenSign credentials.

---

## 6. Docker Compose for local / dev

The authoritative local docker-compose file is `deploy/docker-compose.yml` (verified runnable in AGPL-03; Postgres durable store added in AGPL-05). It runs the full stack: `gateway-postgres` (Postgres 16 durable store), `mock-scentic` (mock webhook receiver, local dev only), `gateway`, Kimai + MariaDB, OpenSign server + frontend, MongoDB, and MailHog. The gateway uses `GATEWAY_STORE_TYPE=postgres` by default and waits for `gateway-postgres` to be healthy before booting. The outline below reflects the implemented service set; always consult `deploy/docker-compose.yml` for the exact, current configuration.

```yaml
version: "3.9"

services:
  gateway:
    build: ./gateway
    ports:
      - "8080:8080"
    environment:
      SCENTIC_AGPL_SERVICE_TOKEN: dev-service-token
      SCENTIC_AGPL_WEBHOOK_SECRET: dev-webhook-secret
      KIMAI_BASE_URL: http://kimai:8001
      KIMAI_API_USER: susan_super
      KIMAI_API_PASSWORD: ${KIMAI_API_PASSWORD:-api-password}
      OPENSIGN_BASE_URL: http://opensign:8081
      OPENSIGN_APP_ID: opensign
      OPENSIGN_MASTER_KEY: dev-master-key
    depends_on: [kimai, opensign]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 15s
      timeout: 5s
      retries: 5

  kimai:
    image: kimai/kimai2:apache
    ports:
      - "8001:8001"
    environment:
      DATABASE_URL: mysql://kimai:kimai@kimai-mysql:3306/kimai?charset=utf8mb4
      APP_SECRET: dev-kimai-secret
    depends_on: [kimai-mysql]

  kimai-mysql:
    image: mysql:8
    command: --default-authentication-plugin=mysql_native_password --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: kimai
      MYSQL_USER: kimai
      MYSQL_PASSWORD: kimai
    volumes:
      - kimai-mysql-data:/var/lib/mysql

  opensign:
    image: opensign/opensign:latest   # or build from vendor/opensign
    ports:
      - "8081:8081"
    environment:
      APP_ID: opensign
      MASTER_KEY: dev-master-key
      SERVER_URL: http://opensign:8081/app
      MONGO_URL: mongodb://opensign-mongo:27017/opensign
      # S3/GCS storage (use local/minio for dev):
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: minio
      S3_SECRET_KEY: minio123
      S3_BUCKET: opensign
      # Email:
      MAILGUN_API_KEY: ${MAILGUN_API_KEY:-}
      # PDF signing:
      PFX_CERTIFICATE_PATH: /run/secrets/opensign.pfx
      PFX_PASSWORD: ${PFX_PASSWORD:-}
    depends_on: [opensign-mongo, minio]
    volumes:
      - ./secrets/opensign.pfx:/run/secrets/opensign.pfx:ro

  opensign-mongo:
    image: mongo:7
    environment:
      MONGO_INITDB_ROOT_USERNAME: opensign
      MONGO_INITDB_ROOT_PASSWORD: opensign
    volumes:
      - opensign-mongo-data:/data/db

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio123
    volumes:
      - minio-data:/data

volumes:
  kimai-mysql-data:
  opensign-mongo-data:
  minio-data:
```

Local bring-up steps:

1. `cp .env.example .env` and fill dev values.
2. `docker compose -f deploy/docker-compose.yml up -d`
3. `docker compose -f deploy/docker-compose.yml exec kimai bin/console kimai:install -n`
4. `docker compose -f deploy/docker-compose.yml exec kimai bin/console kimai:user:create susan_super --super-admin`
5. Create Kimai API token via the UI (Profile → API).
6. Create OpenSign app/tenant and verify the gateway `GET /health`.

### 6.1 Local deployment (AGPL-03 verified)

The full local bring-up procedure — architecture overview, setup, health checks, contract test commands, troubleshooting, "what is NOT production-ready", and "how to keep Scentic proprietary core separate" — is documented in `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §12. That section is the canonical local deployment guide; the steps above are the short form.

**Verified local service ports** (from `deploy/docker-compose.yml`):

| Service | Port | Notes |
|---------|------|-------|
| gateway | `3101` | `GET /health` (public), `GET /api/v1/status` (public, reports `stores.durable`/`stores.productionSuitable`), HMAC-signed routes under `/api/v1/...` |
| gateway-postgres | `5433` → 5432 | Postgres 16 durable store (mappings/nonces/idempotency/outbox) |
| mock-scentic | `3199` | Mock Scentic webhook receiver (local dev only; verifies HMAC, logs events) |
| kimai | `8001` | Kimai UI + API |
| opensign-server | `8080` | Parse Server REST (`/app`) |
| opensign-frontend | `3000` | OpenSign React UI |
| opensign-mongo | `27018` → 27017 | MongoDB for OpenSign |
| mailhog | `8025` / `1025` | Local email catcher UI / SMTP |

**Local health checks:**

```bash
curl http://localhost:3101/health        # gateway + deps
curl http://localhost:3101/api/v1/status # gateway status (stores.durable=true, productionSuitable=true with postgres)
curl http://localhost:3199/health        # mock Scentic receiver
curl http://localhost:8001/              # Kimai login page (200)
curl http://localhost:8080/app           # OpenSign Parse (200)
docker compose -f deploy/docker-compose.yml exec gateway-postgres pg_isready -U gateway
```

**Local contract tests:**

```bash
pnpm --filter gateway test        # Vitest (unit + integration)
pnpm --filter gateway typecheck   # tsc --noEmit
pnpm --filter gateway build       # tsc → dist/
```

**What is NOT production-ready (local stack):** Docker Postgres volume is local (no backup/restore/HA tested), dev placeholder secrets, mock-only upstream tests, admin/master-key fallback for upstream auth, plain HTTP (no TLS), no monitoring/alerting, and the `mock-scentic` receiver is a local dev harness (does not persist events or update Scentic workflow state). See `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §12.6 and §13.

---

## 7. Health checks, monitoring, logging

### Health checks

| Service | Endpoint | Expected |
|---|---|---|
| Gateway | `GET /health` | `200 { status:"ok", deps:{ kimai:"ok", opensign:"ok" } }` |
| Gateway status | `GET /api/v1/status` | `200` with `stores.durable=true`, `stores.productionSuitable=true` (Postgres) |
| Kimai | Kimai `/api/ping` or HTTP 200 on the login page | 200 |
| OpenSign | Parse Server `/app/{APP_ID}/health` or `GET /` | 200 |
| Cloud SQL MySQL (Kimai) | Cloud SQL proxy health | Up |
| Cloud SQL Postgres (gateway store) | `pg_isready` / Cloud SQL connector health | Up |
| MongoDB | Atlas connection status / `rs.status()` | Healthy |
| GCS bucket | Object HEAD on a health probe object | 200 |

### Monitoring

- **Uptime checks:** Cloud Monitoring uptime checks on the gateway `/health` (internal) and on public signing pages.
- **Alerts:**
  - Gateway 5xx rate > threshold.
  - Gateway p99 latency > threshold.
  - Kimai/OpenSign container restarts > threshold.
  - Cloud SQL CPU / disk > 80%.
  - MongoDB Atlas alerts (connections, disk, replication lag).
  - Secret Manager access denials > 0.
- **Dashboards:** Per-service dashboards (RPS, latency, error rate, dependency health) in Cloud Monitoring.

### Logging

- All services emit structured JSON logs to stdout → Cloud Logging.
- Correlation IDs propagated from the Scentic core through the gateway.
- Audit logs enabled in `scentic-agpl-prod` for Admin Activity and Data Access (especially Secret Manager and GCS).

---

## 8. Resource requirements (estimated)

### Gateway

- CPU: 0.5–1 vCPU per instance.
- Memory: 512 MiB – 1 GiB.
- Concurrency: 80 (Cloud Run default).
- Min instances: 1 (avoid cold starts); max: 10 (tune to load).

### Kimai

- CPU: 1–2 vCPU.
- Memory: 1–2 GiB.
- Persistent disk (GCE): 20 GiB for `var/`.

### Kimai MySQL (Cloud SQL)

- Tier: `db-n1-standard-1` minimum for production; HA regional.
- Storage: 50 GiB SSD, autoscale.
- Region: same as the AGPL project.

### OpenSign

- CPU: 1 vCPU.
- Memory: 1 GiB.

### MongoDB

- Atlas M10 (2 GB RAM, 10 GB storage) minimum for production; scale based on envelope volume.

### GCS

- Start small; grows with signed envelope volume. Lifecycle policies control long-term cost.

---

## 9. Cost considerations

| Item | Rough driver | Notes |
|---|---|---|
| Cloud Run (gateway) | Requests + vCPU-sec + GiB-sec | Min-instances keeps a small always-on cost. |
| Cloud Run / GCE (Kimai) | Always-on | GCE may be cheaper for steady load; Cloud Run cheaper for spiky load. |
| Cloud SQL (Kimai MySQL) | Always-on tier + storage | HA doubles compute cost. Single-zone acceptable for staging. |
| OpenSign (Cloud Run / GCE) | Always-on | Polling worker keeps CPU active. |
| MongoDB Atlas | Always-on M10+ | Largest fixed cost. Self-hosting on GCE is cheaper but higher ops burden. |
| GCS | GB-month + operations | Modest until envelope volume grows. Lifecycle transitions reduce cost. |
| Network egress | Scentic↔AGPL traffic via peering | Peered/internal traffic is cheaper than internet egress. |
| Secret Manager | Secret versions + access calls | Negligible at this scale. |

### Cost reduction tactics

- Scale gateway to zero off-hours (accept cold starts) for non-production.
- Use Cloud SQL `db-custom` with right-sized CPU/RAM after the first month of metrics.
- Use GCS Nearline/Coldline lifecycle transitions for completed envelopes.
- Prefer VPC peering over internet egress for Scentic↔AGPL traffic.
- Consider MongoDB Atlas shared-tier (M0/M2/M5) only for dev; production requires M10+ for replicas and backups.

---

## 10. Rollout order

1. Provision `scentic-agpl-prod` GCP project, billing, VPC, Cloud DNS private zone.
2. Peer VPCs with the Scentic core project.
3. Provision Cloud SQL (Kimai MySQL), **Cloud SQL Postgres (gateway durable store — see §3.5 and `deploy/gcloud/deploy-commands.md` §5)**, MongoDB Atlas (peer to AGPL VPC), GCS bucket.
4. Deploy Kimai, run installer, create admin + initial API tokens.
5. Deploy OpenSign, configure storage/mail/PFX, create initial app/tenant.
6. Deploy gateway (internal-only), wire Kimai/OpenSign base URLs and tokens from Secret Manager; set `GATEWAY_STORE_TYPE=postgres` and `GATEWAY_DATABASE_URL` from Secret Manager.
7. Point Scentic core at the gateway via internal URL + service token (see `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md`).
8. Enable uptime checks, alerts, dashboards.
9. Run end-to-end connection tests (see connection manual §9).

---

## References

- `.env.example` — canonical environment variable list.
- `docs/SOURCE_OFFER.md` — AGPL source-offer compliance.
- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` — operator connection manual (§12 local deployment).
- `docs/SCENTIC_INTERFACE_SPEC.md` — implemented interface (27 routes + 21 webhooks + HMAC rules).
- `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` — Scentic-side changes (documentation only).
- `docs/SCENTIC_ENV_VARS_REQUIRED.md` — Scentic-side env vars.
- `docs/NEXT_STEPS.md` — implementation roadmap.
- `docs/API_CONTRACTS.md` — gateway API contracts (planning surface).
- `deploy/docker-compose.yml` — local docker-compose stack.
- `deploy/env.example` — deployment env template.
- `deploy/secrets.example.md` — Secret Manager naming convention.
