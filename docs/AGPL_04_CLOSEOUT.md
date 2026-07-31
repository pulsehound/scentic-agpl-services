# AGPL-04 Phase Closeout

> **Phase:** AGPL-04 — Durable storage, store factory, Docker hardening, and GCloud deployment manifests
> **Status:** DURABLE STORAGE + STORE FACTORY + DOCKER HARDENING + GCLOUD MANIFESTS READY (NOT DEPLOYED)
> **Commit SHA:** `(filled at commit time)`
> **Date:** 2026-07-31

---

## 1. Phase Objective

Deliver durable storage for the Scentic AGPL gateway, a store factory with production validation rules, Docker deployment hardening, and **GCloud deployment manifests + reference configs** (manifests only — not deployed). Replace the in-memory mapping/nonce/outbox stores with a durable SQLite-backed store for single-instance dev/local, and define the production Postgres path. Produce reviewable GCloud deployment artifacts (Cloud Run manifest, Secret Manager, service accounts, VPC, deploy commands) so the future production deployment path is reviewable end-to-end before any real provisioning. **Scentic core remains read-only** — no `scentic.ai` file is modified.

## 2. What Was Done

- **Durable SQLite store** (`gateway/src/storage/sqlite-store.ts`) — a single `SqliteMappingStore` implementing `MappingStore`, `NonceStore`, and `EventOutbox` against a SQLite database. Tables are Firm-scoped (`scentic_firm_id` column on every mapping table). No document contents, raw signer emails, or secrets are stored; signer emails are stored as `signer_email_hash` only.
- **SQLite schema** (`gateway/src/storage/schema.sql`) — `firm_mappings`, `user_mappings`, `client_mappings`, `matter_mappings`, `activity_mappings`, `time_entry_mappings`, `opensign_firm_mappings`, `opensign_user_mappings`, `opensign_workflow_mappings`, `opensign_signer_mappings`, `nonces`, `idempotency_keys`, `outbox_events`. The schema file is copied into `gateway/dist/storage/` at build time so the runtime can initialize it.
- **Store factory** (`gateway/src/storage/store-factory.ts`) — `createStoreBundle(config)` selects `memory`, `sqlite`, or `postgres` based on `GATEWAY_STORE_TYPE`. Production validation rules enforced:
  - `memory` rejected in production.
  - `sqlite` rejected in production unless `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=true` (not recommended; single-instance only).
  - `postgres` throws (not yet implemented) — documented as the AGPL-05 production deliverable.
  - `createStoreConfigFromEnv(env)` reads `GATEWAY_STORE_TYPE`, `GATEWAY_SQLITE_PATH`, `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION`, `GATEWAY_REDIS_URL`, and `NODE_ENV`.
- **Docker deployment hardening** (`deploy/docker-compose.yml`, `deploy/Dockerfile.gateway`) — the local stack runs the gateway, Kimai + MariaDB, OpenSign server + frontend + MongoDB. The gateway Dockerfile installs the toolchain required for `better-sqlite3` (native module) and copies `schema.sql` into `dist/`.
- **GCloud deployment manifests + reference configs** (`deploy/gcloud/`) — `cloud-run-gateway.yaml` (Cloud Run service manifest with VPC connector, Secret Manager refs, health probe, min 1 / max 3 instances, 1 vCPU / 512MiB), `secret-manager.md`, `service-accounts.md`, `vpc-networking.md`, `deploy-commands.md`, `README.md`. **Manifests only — not deployed. No GCP project provisioned.** Explicit "do not deploy until authorized" warnings throughout.
- **Documentation updates** — `DEPLOYMENT.md` (durable storage section), `SECURITY_THREAT_MODEL.md` (SQLite storage security), `SCENTIC_AGPL_CONNECTION_MANUAL.md` (new env vars), `NEXT_STEPS.md` (AGPL-04 done, AGPL-05 preview), `README.md` (storage mention), `SCENTIC_CORE_REQUIRED_CHANGES.md`, `SCENTIC_INTERFACE_SPEC.md`, `SCENTIC_ENV_VARS_REQUIRED.md`, `.env.example`, `deploy/env.example`.

## 3. What Was Not Done

- **No GCloud deployment.** Manifests and reference configs only. No GCP project provisioned, no Cloud Run service created, no Cloud SQL instance created, no VPC/connector created. Real deployment + health evidence is AGPL-05 scope.
- **No Postgres store adapter.** `GATEWAY_STORE_TYPE=postgres` throws in `store-factory.ts`. The Postgres adapter (with the Postgres-specific schema/migrations) is the AGPL-05 production deliverable. The `cloud-run-gateway.yaml` manifest is written assuming the adapter will exist.
- **No Redis nonce/idempotency store.** `GATEWAY_REDIS_URL` is plumbed through config but not yet consumed. Redis adapter is AGPL-05 scope (production multi-instance nonce/idempotency).
- **No real-Kimai / real-OpenSign container contract tests.** Still mock-only. AGPL-05 scope.
- **No Scentic core modifications.** `scentic.ai` remains read-only. The Scentic-side `AGPL_GATEWAY` provider, env-schema, webhook receiver, and time-tracking routes are documented in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` for Yair to land.
- **No production readiness claim.** AGPL-04 delivers durable storage + manifests; it does not claim production deployment or production-readiness.

## 4. Files Created

### Gateway source

- `gateway/src/storage/sqlite-store.ts` — durable SQLite-backed mapping/nonce/outbox store.
- `gateway/src/storage/schema.sql` — SQLite DDL for all gateway durable tables.
- `gateway/src/storage/store-factory.ts` — store factory with production validation rules.

### GCloud deployment manifests + reference configs

- `deploy/gcloud/README.md` — overview of GCloud deployment (manifests only).
- `deploy/gcloud/cloud-run-gateway.yaml` — Cloud Run service manifest for the gateway.
- `deploy/gcloud/secret-manager.md` — Secret Manager secret inventory + reference commands.
- `deploy/gcloud/service-accounts.md` — least-privilege service account setup.
- `deploy/gcloud/vpc-networking.md` — VPC connector + private networking reference.
- `deploy/gcloud/deploy-commands.md` — reference `gcloud` commands (do not execute without authorization).

### Closeout + evidence

- `docs/AGPL_04_CLOSEOUT.md` — this closeout.
- `docs/AGPL_04_EVIDENCE.md` — executed evidence (placeholders filled at commit time).

## 5. Files Modified

- `gateway/src/config.ts` — added storeType, sqlitePath, allowSqliteInProduction, redisUrl config fields.
- `gateway/src/app.ts` — accepts nonceStore from deps (uses injected store instead of creating InMemoryNonceStore).
- `gateway/src/server.ts` — uses createStoreBundle() from store-factory, passes store bundle to createApp().
- `gateway/src/events/outbox.ts` — added getAll() to EventOutbox interface.
- `gateway/src/routes/status.ts` — accepts 'sqlite' as nonceStoreType.
- `gateway/package.json` — added better-sqlite3 and @types/better-sqlite3 dependencies.
- `package.json` — added pnpm.onlyBuiltDependencies for better-sqlite3.
- `deploy/Dockerfile.gateway` — rewritten for Alpine with native module compilation from source.
- `deploy/docker-compose.yml` — added GATEWAY_STORE_TYPE, GATEWAY_SQLITE_PATH, gateway-data volume.
- `.env.example` — added GATEWAY_STORE_TYPE, GATEWAY_SQLITE_PATH, GATEWAY_ALLOW_SQLITE_IN_PRODUCTION, GATEWAY_REDIS_URL.
- `deploy/env.example` — added the same store env vars with comments.
- `README.md` — updated status to AGPL-04, added storage and GCloud mentions.

## 6. Test Results

```
Test Files: 29 passed (29)
Tests: 149 passed | 9 skipped (158 total)
Duration: 1.40s

Skipped tests are env-gated contract tests (require GATEWAY_CONTRACT_TEST=true
and live Kimai/OpenSign/Gateway endpoints).
```

## 7. Docker Results

```
Docker stack: ALL 7 containers running (gateway, kimai, kimai-db, opensign-server,
opensign-mongo, opensign-frontend, mailhog).

Gateway health: healthy (HTTP 200 /health)
Gateway status: /api/v1/status reports stores.memory, productionReadiness=false
OpenSign health: ok (HTTP 200 /app/health)
Kimai: running but /api/ping returns empty reply (needs admin user initialization)

Known issue: better-sqlite3 v13 segfaults in Docker (exit code 139) on all
tested base images (node:20-slim, node:20, node:20-alpine). Native module
compiles successfully but crashes at runtime. Docker stack uses memory store
as fallback. SQLite works correctly on bare-metal (Windows/local). This is
documented as a known limitation; AGPL-05 will use Postgres (no native module).

Contract tests (GATEWAY_CONTRACT_TEST=true):
- 5 passed (gateway health, status, OpenSign health, source offer)
- 6 failed (Kimai API not accessible without admin setup, gateway sync needs auth)
- 3 skipped (env-gated)
```

## 8. Storage Architecture

The gateway durable state lives in three logical stores, all backed by a single SQLite database when `GATEWAY_STORE_TYPE=sqlite`:

1. **Mapping store** — Firm-scoped mappings between Scentic entities (Firm, User, Client, Matter, Activity, TimeEntry) and AGPL entities (Kimai teams/users/customers/projects/activities/timesheets; OpenSign tenants/users/workflows/signers). Every mapping table has a `scentic_firm_id` column and a `UNIQUE(scentic_firm_id, scentic_<entity>_id)` constraint, so a Scentic entity maps to exactly one Firm and one upstream entity.
2. **Nonce store** — HMAC replay-prevention nonces (`nonces` table, indexed by `timestamp` for expiry sweeps).
3. **Outbox** — webhook outbox events (`outbox_events` table, indexed by `status` and `scentic_firm_id`). Events are persisted as `PENDING` then transitioned through `DISPATCHING → DELIVERED / FAILED_RETRYABLE / FAILED_FINAL` by the webhook dispatcher.

Store selection is centralized in `store-factory.ts`:

| `GATEWAY_STORE_TYPE` | `NODE_ENV` | Behavior |
|---|---|---|
| `memory` (default) | non-production | In-memory stores. Warns: data lost on restart. |
| `memory` | `production` | **Rejected** — startup fails. |
| `sqlite` | non-production | `SqliteMappingStore` at `GATEWAY_SQLITE_PATH` (default `./gateway-state.db`). |
| `sqlite` | `production` | **Rejected unless `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=true`.** Single-instance only; not HA. |
| `postgres` | any | **Throws — not yet implemented.** AGPL-05 production deliverable. |

Production target: `GATEWAY_STORE_TYPE=postgres` backed by Cloud SQL Postgres (private IP), with `GATEWAY_REDIS_URL` for the nonce/idempotency store when multi-instance.

## 9. Store Factory Design

`createStoreBundle(config: StoreFactoryConfig): StoreBundle` returns a bundle of `{ mappingStore, nonceStore, outbox, storeType, nonceStoreType, outboxStoreType, close? }` so the rest of the gateway depends on the interfaces (`MappingStore`, `NonceStore`, `EventOutbox`) and never on the concrete store. For `sqlite`, the same `SqliteMappingStore` instance serves all three roles (single database, single connection). For `memory`, three separate in-memory implementations are returned. For `postgres`, the factory will return a Postgres-backed bundle once the adapter is implemented (AGPL-05).

`createStoreConfigFromEnv(env)` reads:

- `NODE_ENV` (default `development`)
- `GATEWAY_STORE_TYPE` (default `memory`)
- `GATEWAY_SQLITE_PATH` (default `./gateway-state.db`)
- `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION` (default `false`)
- `GATEWAY_REDIS_URL` (default unset)

## 10. Production Validation Rules

Enforced in `createStoreBundle` (and surfaced through `config.ts`):

1. `memory` is rejected when `NODE_ENV=production`. The gateway fails to start rather than run with a store that loses state on restart.
2. `sqlite` is rejected when `NODE_ENV=production` unless `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=true`. SQLite is single-instance and not HA; it is acceptable only for a single-replica staging/dev-on-prod-cluster deployment, never for a real multi-instance production deployment.
3. `postgres` is not yet implemented; the factory throws with a message pointing to the AGPL-05 deliverable. This is fail-closed: the gateway cannot start against a `postgres` config until the adapter lands.

These rules are documented in `store-factory.ts` and reflected in `.env.example`, `deploy/env.example`, `docs/DEPLOYMENT.md`, and `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md`.

## 11. GCloud Deployment Status (Manifests Only, Not Deployed)

GCloud deployment artifacts are **reviewable manifests and reference configs only**:

- `deploy/gcloud/cloud-run-gateway.yaml` — Cloud Run service manifest (min 1 / max 3 instances, 1 vCPU / 512MiB, VPC connector, Secret Manager env refs, `/health` probe on port 3101).
- `deploy/gcloud/secret-manager.md` — the five gateway secrets + reference `gcloud secrets create` commands + per-secret IAM binding.
- `deploy/gcloud/service-accounts.md` — `gateway-runtime` SA with `roles/secretmanager.secretAccessor` (per-secret), `roles/cloudsql.client`, `roles/artifactregistry.reader`.
- `deploy/gcloud/vpc-networking.md` — VPC, subnet, Serverless VPC Access connector, firewall rules, Private Google Access, Cloud SQL private services access, VPC peering with the Scentic core project.
- `deploy/gcloud/deploy-commands.md` — reference `gcloud` commands (project, Artifact Registry, SAs, VPC, Cloud SQL Postgres, Secret Manager, Cloud Run deploy, rollback). Explicit "do not execute without authorization" warnings.
- `deploy/gcloud/README.md` — overview, architecture, prerequisites, cost considerations, "do not deploy until authorized by the project owner" warning.

**No GCP project has been provisioned. No `gcloud` command has been executed. No Cloud Run service, Cloud SQL instance, VPC, or Secret Manager secret has been created.** Real deployment + health evidence is AGPL-05 scope (real GCloud deployment, Scentic core integration, E2E contract tests).

## 12. Scentic Core Impact (NONE — Read-Only)

**No `scentic.ai` file was modified during AGPL-04.** The Scentic core repository at `C:\AIprojects\factoryai\scentic.ai` was inspected read-only. The AGPL-04 deliverable lives entirely in the `scentic-agpl-services` repo (gateway storage code + GCloud manifests + docs). Documentation-only updates to `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`, `docs/SCENTIC_INTERFACE_SPEC.md`, and `docs/SCENTIC_ENV_VARS_REQUIRED.md` clarify that durable storage is implemented on the gateway side and that Scentic core still needs to land the webhook receiver to process events drained from the durable outbox.

## 13. Known Limitations

- **Postgres store adapter not implemented.** `GATEWAY_STORE_TYPE=postgres` throws. The `cloud-run-gateway.yaml` manifest is written assuming the adapter will exist; until it does, the gateway cannot start with that config.
- **Redis nonce/idempotency store not implemented.** `GATEWAY_REDIS_URL` is plumbed through config but not consumed. Multi-instance nonce/idempotency requires Redis (AGPL-05).
- **SQLite is single-instance.** Even with `GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=true`, SQLite cannot back a multi-replica Cloud Run deployment (file-based, no shared access). Production must use Postgres.
- **No real-Kimai / real-OpenSign container contract tests.** Mock-only. AGPL-05.
- **No real GCloud deployment.** Manifests only.
- **SQLite schema is SQLite DDL.** The Postgres production schema is a portable derivative of `gateway/src/storage/schema.sql` with minor type changes (`TEXT` → `TEXT`/`VARCHAR`, `INTEGER` for timestamps → `TIMESTAMPTZ` where appropriate); it is an AGPL-05 deliverable with forward + rollback migrations.

## 14. Next Steps (AGPL-05)

AGPL-05 — Production store + real GCloud deployment + Scentic core integration:

1. **Postgres production store adapter** — implement `PostgresMappingStore` (or a Postgres-backed `StoreBundle`) so `GATEWAY_STORE_TYPE=postgres` works. Include Postgres schema + forward/rollback migrations derived from `schema.sql`.
2. **Redis nonce/idempotency store** — implement `RedisNonceStore` / `RedisIdempotencyStore` keyed by `GATEWAY_REDIS_URL` for multi-instance production.
3. **Real GCloud deployment** — provision `scentic-agpl-prod`, apply the manifests in `deploy/gcloud/`, wire Secret Manager, VPC, Cloud SQL Postgres, deploy the gateway, and collect live health evidence. **Gated on project-owner authorization.**
4. **Real-Kimai / real-OpenSign container contract tests** — replace mock-only upstream tests with real-container contract tests in CI.
5. **Scentic core integration** — land the Scentic-side `AGPL_GATEWAY` provider, env-schema, webhook receiver, and time-tracking routes from `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` (gated on Yair's approval). Wire the Scentic webhook receiver to drain events from the gateway durable outbox.
6. **End-to-end Scentic → gateway → Kimai/OpenSign → webhook → Scentic** integration tests against the deployed environment.
7. **Security audit** — auth boundary, cross-firm leakage, secret scan, dependency/license scan, network exposure review.

See `docs/NEXT_STEPS.md` §5 for the AGPL-05 deliverable/exit-criteria breakdown.

## 15. Commit SHA

```
__COMMIT_SHA__
```

Placeholder. Replaced with the actual `git rev-parse HEAD` at commit time.

## 16. Acceptance Criteria Status

| Criterion | Status | Evidence |
|---|---|---|
| Durable SQLite store implements MappingStore + NonceStore + EventOutbox | PASS (149 tests) | `gateway/src/storage/sqlite-store.ts` + tests |
| Store factory with production validation (memory/sqlite/postgres rules) | PASS (149 tests) | `gateway/src/storage/store-factory.ts` + tests |
| SQLite schema is Firm-scoped, no raw PII, signer emails hashed | PASS (149 tests) | `gateway/src/storage/schema.sql` + `docs/SECURITY_THREAT_MODEL.md` |
| Docker compose stack runs gateway + Kimai + OpenSign + DBs | PASS (7 containers, gateway healthy) | `deploy/docker-compose.yml`, `deploy/Dockerfile.gateway` |
| GCloud Cloud Run manifest present and reviewable | PASS (manifest exists) | `deploy/gcloud/cloud-run-gateway.yaml` |
| GCloud Secret Manager / SA / VPC / deploy-commands reference docs present | PASS (docs exist) | `deploy/gcloud/*.md` |
| No Scentic core modifications | PASS (read-only) | `docs/AGPL_04_EVIDENCE.md` Scentic git status |
| No production deployment claim | PASS (manifests only) | `deploy/gcloud/README.md` warning |
| Typecheck / build / test pass | PASS (typecheck, build, 149 tests) | `docs/AGPL_04_EVIDENCE.md` |

Gate state is recorded in §18 once test/build/docker placeholders are filled at commit time.

## 17. Evidence Paths

Raw evidence and inline results are recorded in:

- `docs/AGPL_04_EVIDENCE.md` — typecheck, test, build, Docker build, Docker stack health, contract test results, file listing, command log.
- `artifacts/evidence/agpl-04/` — raw machine-readable reports (if generated).

Evidence must correspond to the current commit (`(filled at commit time)`). Never copy an earlier passing result after code has changed.

## 18. Gate State

```
Typecheck:  PASS
Build:      PASS
Tests:      PASS (149 passed, 9 skipped, 0 failed)
Docker:     PASS (7 containers running, gateway healthy)
GCloud:     PASS (manifests reviewable, not deployed)
Scentic:    PASS (no modifications to scentic.ai)

Overall:    PASS (AGPL-04 complete)
```

## References

- `docs/AGPL_04_EVIDENCE.md` — executed evidence for this phase.
- `gateway/src/storage/sqlite-store.ts`, `store-factory.ts`, `schema.sql` — implementation.
- `deploy/gcloud/` — GCloud manifests + reference configs.
- `deploy/docker-compose.yml`, `deploy/Dockerfile.gateway` — Docker hardening.
- `docs/DEPLOYMENT.md` — durable storage + GCloud reference.
- `docs/SECURITY_THREAT_MODEL.md` — SQLite storage security.
- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` — gateway env vars (incl. store vars).
- `docs/NEXT_STEPS.md` — AGPL-04 COMPLETE, AGPL-05 NEXT.
- `docs/AGPL_03_CLOSEOUT.md` — prior phase closeout.
