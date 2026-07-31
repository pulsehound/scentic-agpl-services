# AGPL-03 Phase Closeout

> **Phase:** AGPL-03 — Local deployment + connection interface
> **Status:** LOCAL DEPLOYMENT + CONNECTION INTERFACE READY
> **Commit SHA:** `f7e73ba`
> **Date:** 2026-07-31

---

## 1. Summary

AGPL-03 delivered the **local deployment** of the AGPL stack and the **complete Scentic ↔ AGPL connection interface documentation**. The gateway-side webhook dispatcher (the AGPL-02 carried gap) was implemented, unit-tested, and documented. The Scentic-core-side changes are fully specified as **documentation only** — no Scentic proprietary file was modified. The phase was reframed at closeout from "land Scentic-core-side code" to "local deployment + connection interface documentation", because the Scentic core edits require Yair's approval to land in a separate proprietary repository.

### What was implemented (gateway side, in this AGPL repo)

- **Webhook dispatcher** (`gateway/src/events/webhook-dispatcher.ts`):
  - HMAC-SHA256 signed outbound webhooks to `{SCENTIC_WEBHOOK_TARGET_URL}`.
  - Exponential backoff retry (initial 5s, cap 10 min, max 24h total).
  - Idempotency key per event (`evt-<eventId>`); at-least-once delivery.
  - 4xx (except 429) → stop retries; 5xx/429 → retryable.
  - Disabled safely when `SCENTIC_WEBHOOK_TARGET_URL` or `SCENTIC_WEBHOOK_HMAC_SECRET` is unset (no unsigned webhooks).
  - No document contents, signing links, or raw signer emails in payloads.
  - Event status tracking: `PENDING → DISPATCHING → DELIVERED / FAILED_RETRYABLE / FAILED_FINAL`.
- **Webhook signer** (`gateway/src/events/webhook-signer.ts`):
  - Canonical-string HMAC: `[body, timestamp, nonce, eventId, firmId, correlationId].join('\n')`.
  - Headers: `X-Gateway-Signature` (`sha256=<hex>`), `X-Gateway-Timestamp`, `X-Gateway-Nonce`, `X-Gateway-Event-Id`, `X-Gateway-Firm-Id`, `X-Gateway-Correlation-Id`, `Idempotency-Key`.
  - Constant-time verification helper for relay/test scenarios.
- **Webhook types** (`gateway/src/events/webhook-types.ts`): `WebhookPayload`, `WebhookHeaders`, dispatch status types, dispatcher config.
- **21 event types** carried in the outbox (`gateway/src/events/outbox.ts`): 9 Kimai + 12 OpenSign, all dispatch-eligible.

### What was documented (new docs)

- `docs/SCENTIC_INTERFACE_SPEC.md` — authoritative interface: 27 Scentic→Gateway routes (16 Kimai-surface + 11 OpenSign-surface), 21 webhook event types with payload schemas + `safeSummary` examples, HMAC signing rules both directions (canonical strings + headers), error code table, retry behavior, data minimization table, multi-firm/multi-user mapping rules.
- `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` — documentation-only spec of every Scentic-core change (provider type, provider impl, env-schema, webhook receiver, time-tracking routes, provider health, audit events, ProviderMapping usage, security checklist, test checklist, release-blocker impact). Explicitly states NO CHANGES APPLIED.
- `docs/SCENTIC_ENV_VARS_REQUIRED.md` — Scentic-side env vars (required + optional), production validation rules, secret rotation guidance, local test config, disabled-state behavior.

### What was updated (existing docs/config)

- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` — status header updated; new §12 "Local deployment" (architecture overview, setup, health checks, contract test commands, troubleshooting, "what is NOT production-ready", "how to keep Scentic proprietary core separate").
- `docs/DEPLOYMENT.md` — status updated; §6 enhanced with the verified `deploy/docker-compose.yml` reference, local service ports, health checks, contract tests, and a "what is NOT production-ready" pointer.
- `docs/NEXT_STEPS.md` — AGPL-03 marked COMPLETE; AGPL-04 marked NEXT; §4 reframed (scope note, deliverables split gateway/Scentic, exit criteria, carried gaps); dependency diagram + Scentic-core changes table + references updated.
- `docs/SECURITY_THREAT_MODEL.md` — status updated; T-03 mitigation note added (HMAC signing, timestamp, nonce, idempotency, firm scope in webhook, secret separation, safe payloads, disabled-state safety).
- `README.md` — status updated to "AGPL-03: LOCAL DEPLOYMENT + CONNECTION INTERFACE READY".
- `.env.example` — webhook dispatch config section added (target URL, HMAC secret, tuning vars); production requirements updated (distinct secrets, private webhook target URL, 90-day rotation).
- `deploy/env.example` — gateway section rewritten with the canonical secret names + aliases, `GATEWAY_DATABASE_URL`, webhook dispatch tuning; Kimai admin API token + confidential-label config added.
- `deploy/secrets.example.md` — gateway secrets consolidated with aliases, key-separation note, and AGPL-03 dispatcher note.

## 2. Tests

> Test results: **111 passed, 3 skipped (contract tests, env-gated), 114 total across 21 files.** See `docs/AGPL_03_EVIDENCE.md`.

The AGPL-03 deliverable is primarily documentation + the webhook dispatcher module. Tests cover:

- Webhook signer (HMAC canonical string, constant-time verify, `sha256=` prefix handling).
- Webhook dispatcher (enabled/disabled state, retry on 5xx/429, stop on 4xx, idempotency key, exponential backoff, safe payload construction, event-status transitions).
- Webhook types / outbox event-type allowlist (only the 21 safe event types are dispatchable; unknown types → `FAILED_FINAL`).
- Docs scans (AGPL-03 interface spec present, Scentic-core-changes doc present, no `@scentic/*` imports in gateway, upstream SHAs pinned).

## 3. Validator results

> Independent validation performed via:

- Typecheck: PASS (`tsc --noEmit`, zero errors)
- Test suite: 111/111 PASS, 3 skipped (env-gated contract tests) (Vitest, 21 files)
- Build: PASS (`tsc` compiled, dist/ emitted)
- Scentic core boundary: **PASS** (no AGPL-03 modifications to `scentic.ai`; read-only inspection only)
- OpenSign boundary: **PASS** (`vendor/opensign/` unmodified at pinned SHA)
- Kimai boundary: **PASS** (`vendor/kimai/` unmodified at pinned SHA)
- No `@scentic/*` imports: **PASS** (zero matches in `gateway/src/`)
- License scan: **PASS** (AGPL-3.0 LICENSE present)

Validators (custom droids) not run for AGPL-03 (no custom droids configured for the AGPL repo).

## 4. Boundary verification

- **Scentic core (`scentic.ai`):** NOT MODIFIED. Read-only inspection only. The Scentic-side changes are specified in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` as documentation; no `scentic.ai` tracked file was edited during AGPL-03. See `docs/AGPL_03_EVIDENCE.md` for the Scentic core git status snapshot.
- **OpenSign (`vendor/opensign/`):** NOT MODIFIED. Remains at pinned SHA `f72624fa26211fe00776453d99a67120a4f5e060`.
- **Kimai (`vendor/kimai/`):** NOT MODIFIED. Remains at pinned SHA `7c2ed4b07cca2e15b1ab4cc5947afdf899a76401`.

## 5. Remaining gaps (carried forward)

| Gap | Current state | Production requirement | Resolution phase |
|-----|---------------|--------------------------|------------------|
| Scentic-core-side implementation | Documented in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` only; no `scentic.ai` edits. | Land the provider type, env-schema, webhook receiver, time-tracking routes, provider-health entry, audit events. | On Yair's approval (gates AGPL-04 production cutover) |
| Real-Kimai / real-OpenSign container contract tests | Mock-only. | Real container contract tests in CI. | AGPL-04 |
| Per-user upstream tokens | Admin/master-key fallback. | Per-user Kimai API tokens + OpenSign session tokens. | AGPL-04 |
| Persistent stores | In-memory mapping/nonce/idempotency. | SQLite/Postgres (mapping) + Redis (nonce/idempotency). | AGPL-04 |
| Production deployment | Not provisioned. | GCP `scentic-agpl-prod` project. | AGPL-04 |

These gaps do not block AGPL-03 closeout (the phase scope is local deployment + connection interface documentation), but they MUST be resolved before AGPL-04 production readiness.

## 6. Release blocker impact

- **RB-014 (Real e-signature provider):** documented as **resolved-by-implementation** in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` §11 — landing the Scentic-side `AGPL_GATEWAY` provider + a production OpenSign deployment satisfies RB-014. **Not yet resolved** at AGPL-03 closeout (documentation only; resolution requires the Scentic-side implementation + AGPL-04 deployment + E2E evidence).
- No other release blocker is directly affected by AGPL-03.

## 7. Next phase

**AGPL-04 — Deployment and production readiness.**

AGPL-04 provisions the GCP `scentic-agpl-prod` project, deploys gateway + Kimai + OpenSign + databases, wires Secret Manager, adds health checks/monitoring, runs real-container E2E integration tests, and performs the security audit. AGPL-04 production cutover is gated on Yair landing the Scentic-core-side changes from `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`. See `docs/NEXT_STEPS.md` §5.

## 8. References

- `docs/AGPL_03_EVIDENCE.md` — executed evidence for this phase.
- `docs/SCENTIC_INTERFACE_SPEC.md` — implemented interface (27 routes + 21 webhooks + HMAC rules).
- `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` — Scentic-side changes (documentation only).
- `docs/SCENTIC_ENV_VARS_REQUIRED.md` — Scentic-side env vars.
- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` §12 — local deployment guide.
- `docs/SECURITY_THREAT_MODEL.md` — T-03 mitigation note.
- `docs/UPSTREAM_SOURCES.md` — pinned upstream SHAs.
- `gateway/src/events/webhook-dispatcher.ts`, `webhook-signer.ts`, `webhook-types.ts`, `outbox.ts` — implementation.
- `docs/NEXT_STEPS.md` — phased roadmap.
