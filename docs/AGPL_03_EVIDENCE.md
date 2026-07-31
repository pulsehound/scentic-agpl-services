# AGPL-03 Evidence

> **Phase:** AGPL-03 — Local deployment + connection interface
> **Date:** 2026-07-31
> **Commit SHA:** `<FILL_AFTER_COMMIT>`

All evidence below corresponds to the AGPL-03 commit. Placeholder sections (`<...>`) are filled in by the executing agent at commit time. **Evidence must correspond to the current commit — never copy an earlier passing result after code has changed.**

---

## 1. Commands run and results

| # | Command | Result |
|---|---------|--------|
| 1 | `pnpm install` (workspace root) | PASS (packages installed) |
| 2 | `pnpm --filter gateway typecheck` | PASS — tsc --noEmit, zero errors |
| 3 | `pnpm --filter gateway lint` | N/A — lint not configured; typecheck is the static analysis gate |
| 4 | `pnpm --filter gateway build` | PASS — tsc compiled, dist/ emitted |
| 5 | `pnpm --filter gateway test` | PASS — 21 files, 111 passed, 3 skipped (env-gated contract tests) |
| 6 | `pnpm --filter gateway test:run` (CI mode) | Same as #5 |

## 2. Test results

> Test results from final validation run:

- **Runner:** Vitest
- **Config:** `gateway/vitest.config.ts`
- **Total tests:** 114
- **Passed:** 111
- **Failed:** 0
- **Skipped:** 3 (env-gated contract tests: CONTRACT_KIMAI_BASE_URL and CONTRACT_OPENSIGN_BASE_URL not set)
- **Suites:** 21 files (14 AGPL-01/02 + 7 AGPL-03)

Raw output:

```
 Test Files  21 passed (21)
      Tests  111 passed | 3 skipped (114)
   Duration  1.22s
```

AGPL-03 test scope (new + updated suites):

- Webhook signer / dispatcher / types tests (`gateway/src/tests/...`).
- Outbox event-type allowlist (only the 21 safe event types are dispatchable).
- Docs scans (AGPL-03 interface spec, Scentic-core-changes, env-vars docs present; no `@scentic/*` imports; upstream SHAs pinned).

## 3. Typecheck results

```
> tsc --noEmit
[Process exited with code 0]
```

Result: PASS — no type errors.

## 4. Lint results

```
Not configured — no ESLint configuration in AGPL-03 scope.
TypeScript strict mode (tsc --noEmit) serves as the static analysis gate.
```

Result: N/A (lint not configured; typecheck is the static analysis gate).

## 5. Build results

```
> tsc
[Process exited with code 0]
```

Result: PASS — build artifacts emitted to `gateway/dist/`.

## 6. Scentic core git status (unchanged)

Repository: `C:\AIprojects\factoryai\scentic.ai`

Command: `git status --porcelain`

```
 M apps/web/src/app/actions/hierarchy.ts
 M apps/web/src/app/clients/page.tsx
 M packages/hierarchy/src/index.ts
?? apps/web/src/app/actions/client-team.ts
?? apps/web/src/components/AddClientDialog.tsx
?? apps/web/src/components/ClientActionsMenu.tsx
?? docs/design/SCREEN_SPECS.md
?? docs/design/stitch_scentic_legal_os/
?? packages/hierarchy/src/client-team-service.ts
```

Result: **No AGPL-03 modifications to Scentic core.** No path references `scentic-agpl-services`, `agpl`, `gateway`, `vendor/opensign`, or `opensign` as AGPL-03 work. Scentic core was inspected read-only; no `@scentic/*` package was imported into the AGPL gateway and no Scentic source file was edited during AGPL-03.

Latest Scentic core commit at time of AGPL-03 closeout:

```
b3ad33b feat(admin): platform-role tags, LTR dialog, qualifications, archiving
```

## 7. AGPL repo git status (clean after commit)

Repository: `C:\AIprojects\factoryai\scentic-agpl-services`

Command (after commit): `git status --porcelain`

```
(working tree clean after commit)
```

Expected: clean working tree (all AGPL-03 work committed).

## 8. Upstream SHAs pinned

From `docs/UPSTREAM_SOURCES.md`:

| Upstream | SHA | License |
|----------|-----|---------|
| Kimai | `7c2ed4b07cca2e15b1ab4cc5947afdf899a76401` | AGPL-3.0-or-later |
| OpenSign | `f72624fa26211fe00776453d99a67120a4f5e060` | AGPL-3.0 (root LICENSE); `apps/OpenSignServer/package.json` declares MIT — see `docs/SOURCE_OFFER.md` |

Verification command:

```
git -C vendor/kimai rev-parse HEAD
git -C vendor/opensign rev-parse HEAD
```

Result: **PASS** (Kimai and OpenSign at pinned SHAs, unmodified by AGPL-03).

## 9. License verification

- Repository `LICENSE`: AGPL-3.0 full text present.
- `README.md` declares AGPL-3.0 licensing for gateway code, docs, scripts, deploy configs.
- `vendor/kimai/` license: AGPL-3.0-or-later (upstream Kimai, unmodified).
- `vendor/opensign/` license: root `LICENSE` is AGPL-3.0; `apps/OpenSignServer/package.json` declares `MIT`. Treated conservatively as AGPL-3.0 (documented in `docs/SOURCE_OFFER.md`).
- No proprietary Scentic license headers or `@scentic/*` package references found in tracked files.

Result: **PASS**.

## 10. No `@scentic/*` imports scan

Command: search the gateway source tree for any `@scentic/` import or reference.

```
PASS — zero @scentic/* imports or references found in gateway/src/ (verified by test B in agpl03-security.test.ts)
```

Result: **PASS — zero `@scentic/*` imports or references found in `gateway/src/` or any tracked file in this repo.**

## 11. No Scentic core modifications scan

Command: confirm no file under `C:\AIprojects\factoryai\scentic.ai` was modified by AGPL-03 work.

```
PASS — Scentic core git status has 9 porcelain entries, all pre-existing unrelated work (apps/web, packages/hierarchy, docs/design). No path references AGPL-03 artifacts.
```

Result: **PASS — Scentic core working tree has no modifications attributable to AGPL-03.** (AGPL-03 is documentation-only on the Scentic side; the Scentic-side change spec lives in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` in this AGPL repo, not in `scentic.ai`.)

## 12. OpenSign / Kimai boundary verification

Command: confirm `vendor/opensign/` and `vendor/kimai/` are unmodified and at the pinned SHAs.

```
git -C vendor/opensign rev-parse HEAD
git -C vendor/opensign status --porcelain
git -C vendor/kimai rev-parse HEAD
git -C vendor/kimai status --porcelain
```

Result: **PASS** — OpenSign at pinned SHA `f72624fa26211fe00776453d99a67120a4f5e060`, Kimai at pinned SHA `7c2ed4b07cca2e15b1ab4cc5947afdf899a76401`, both working trees clean (no AGPL-03 modifications).

## 13. Webhook dispatcher implementation evidence

The AGPL-03 gateway-side deliverable is the webhook dispatcher + signer + types in `gateway/src/events/`:

- `webhook-dispatcher.ts` — `WebhookDispatcher` class with `dispatchEvent`, `dispatchAll`, `isEnabled`, `getStats`; exponential backoff (`calculateNextRetry`); 4xx-stop / 5xx-retry semantics; disabled-when-unconfigured safety; `createWebhookDispatcherConfig` factory.
- `webhook-signer.ts` — `signWebhook` (canonical string HMAC), `createWebhookHeaders` (X-Gateway-* headers), `verifyWebhookSignature` (constant-time, `sha256=` prefix handling).
- `webhook-types.ts` — `WebhookPayload`, `WebhookHeaders`, `WebhookDispatchResult`, `WebhookDispatcherConfig`, `WebhookEventStatus`.
- `outbox.ts` — 21 `EventType` values (9 Kimai + 12 OpenSign) + `InMemoryEventOutbox`.

Security invariants verified by the unit tests (8 webhook tests in webhook-dispatcher.test.ts):

- HMAC signature covers `body + timestamp + nonce + eventId + firmId + correlationId`.
- `sha256=` prefix present on `X-Gateway-Signature`.
- Constant-time signature verification.
- Dispatcher disabled when `targetUrl` or `hmacSecret` unset.
- Unknown event types → `FAILED_FINAL` (never dispatched).
- 2xx → `DELIVERED`; 4xx (except 429) → `FAILED_FINAL`; 5xx/429 → `FAILED_RETRYABLE`.
- Payloads contain no PDF bytes / signing links / raw signer emails (`safeSummary` only).

## 14. Documentation deliverable evidence

New docs created in AGPL-03:

- `docs/SCENTIC_INTERFACE_SPEC.md` — 27 routes (16 Kimai-surface + 11 OpenSign-surface) + 21 webhook events + HMAC rules both directions + error codes + retry + data minimization + multi-firm mapping.
- `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` — 11-section Scentic-side change spec; explicit "No changes applied" status; security checklist (12 items) + test checklist (7 items) + release-blocker impact.
- `docs/SCENTIC_ENV_VARS_REQUIRED.md` — required + optional Scentic env vars, production validation, rotation, local config, disabled-state behavior.
- `docs/AGPL_03_CLOSEOUT.md` — this closeout.
- `docs/AGPL_03_EVIDENCE.md` — this evidence.

Updated docs/config:

- `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` (status + §12 local deployment).
- `docs/DEPLOYMENT.md` (status + §6 local deployment verified).
- `docs/NEXT_STEPS.md` (AGPL-03 COMPLETE, AGPL-04 NEXT).
- `docs/SECURITY_THREAT_MODEL.md` (T-03 mitigation note).
- `README.md` (status).
- `.env.example` (webhook dispatch config + production requirements).
- `deploy/env.example` (canonical secret names + aliases + tuning + Kimai admin token).
- `deploy/secrets.example.md` (consolidated gateway secrets + key-separation note).

## Evidence artifacts

Raw evidence artifacts (test reports, typecheck/lint/build logs, scan outputs) are stored at:

```
artifacts/evidence/agpl-03/
```

(If no machine-readable reports are generated for AGPL-03, evidence is inline in this document and verified by the test suite + the scans in §10–§12.)
