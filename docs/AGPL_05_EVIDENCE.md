# AGPL-05 Evidence

> **Phase:** AGPL-05 — Postgres durable store, Docker Postgres stack, final deployment package
> **Date:** 2026-07-31
> **Commit SHA:** `a41ef8f`

---

## 1. Typecheck results

```
$ npx tsc --noEmit
Command completed successfully (exit code 0)
```

Result: **PASS** — zero type errors. All async refactoring compiles cleanly.

## 2. Test results

```
Test Files: 35 passed (35)
Tests: 162 passed | 9 skipped (171 total)
Duration: ~1.6s
```

Result: **PASS** — 162 tests passed, 9 skipped (env-gated Postgres and contract tests).

New AGPL-05 test suites:
- `storage/postgres-store.test.ts` — Tests A-K (env-gated, require GATEWAY_PG_TEST_URL)
- `agpl05-docker.test.ts` — Tests M-Q (Docker config static checks)
- `agpl05-security.test.ts` — Tests W-AF (security boundary checks)
- `agpl05-docs.test.ts` — Tests AG-AL (doc existence checks)
- `agpl05-regression.test.ts` — Tests AM-AP (regression smoke tests)
- `mock-webhook-receiver.test.ts` — Test V (mock receiver verification)

## 3. Build results

```
$ npx tsc
Build exit: 0
```

Result: **PASS** — build artifacts emitted to `gateway/dist/`.

## 4. Docker build results

```
$ docker compose -f deploy/docker-compose.yml build gateway
=> [1/8] FROM node:20-alpine
=> [3/8] RUN npm install
=> [6/8] RUN ./node_modules/.bin/tsc  DONE 0.9s
=> [7/8] RUN cp src/storage/postgres-schema.sql dist/storage/postgres-schema.sql  DONE
=> [8/8] RUN cp src/storage/schema.sql dist/storage/schema.sql  DONE
=> naming to docker.io/library/deploy-gateway:latest  Built
```

Result: **PASS** — gateway image builds without native module compilation (pg is pure JS).

## 5. Docker stack health results

```
$ docker compose -f deploy/docker-compose.yml up -d
All 9 containers started:
  deploy-gateway-1            Up (healthy)
  deploy-gateway-postgres-1   Up (healthy)
  deploy-mock-scentic-1       Up
  deploy-kimai-1              Up (healthy)
  deploy-kimai-db-1           Up (healthy)
  deploy-opensign-mongo-1     Up (healthy)
  deploy-opensign-server-1    Up
  deploy-opensign-frontend-1  Up
  deploy-mailhog-1            Up

$ curl http://localhost:3101/health
{"ok":true,"data":{"status":"healthy","version":"0.1.0"}}

$ curl http://localhost:3101/api/v1/status
{"ok":true,"data":{"stores":{"mapping":"postgres","nonce":"postgres","outbox":"postgres",
"durable":true,"productionSuitable":true},...}}

$ curl http://localhost:3199/health
{"ok":true,"service":"mock-scentic","eventsReceived":0}

Gateway logs:
[gateway] Store type: postgres (nonce: postgres, outbox: postgres)
```

Result: **PASS** — gateway healthy with Postgres durable store. Mock Scentic receiver healthy.

## 6. Contract test results

Contract tests remain env-gated. Postgres store tests (A-K) are env-gated (require GATEWAY_PG_TEST_URL). Docker contract tests require GATEWAY_CONTRACT_TEST=true and Kimai admin user setup.

## 7. Scentic core git status

```
$ cd C:\AIprojects\factoryai\scentic.ai && git status --porcelain
?? docs/design/SCREEN_SPECS.md
?? docs/design/stitch_scentic_legal_os/
```

Result: **No AGPL-05 modifications to Scentic core.** Only pre-existing untracked files.

## 8. Multi-instance safety decision

Postgres provides sufficient multi-instance safety:
- **Nonces:** `INSERT ... ON CONFLICT (nonce) DO NOTHING` — atomic replay prevention
- **Idempotency:** `INSERT ... ON CONFLICT` — atomic duplicate prevention
- **Outbox:** `SELECT ... FOR UPDATE SKIP LOCKED` — safe concurrent processing

Redis is **optional** — Postgres is sufficient. Documented in `docs/DEPLOYMENT.md` and `docs/SECURITY_THREAT_MODEL.md`.
