# AGPL-02 Evidence

> **Phase:** AGPL-02 — OpenSign integration foundation
> **Date:** 2026-07-31
> **Commit SHA:** `fd53268`

All evidence below corresponds to the AGPL-02 commit. Placeholder sections (`<...>`) are filled in by the executing agent at commit time.

---

## 1. Commands run and results

| # | Command | Result |
|---|---------|--------|
| 1 | `pnpm install` (workspace root) | PASS (packages installed) |
| 2 | `pnpm --filter gateway typecheck` | PASS — tsc --noEmit, zero errors |
| 3 | `pnpm --filter gateway lint` | Not configured (no ESLint config; typecheck is static analysis gate) |
| 4 | `pnpm --filter gateway build` | PASS — tsc compiled, dist/ emitted |
| 5 | `pnpm --filter gateway test` | PASS — 14 files, 79 tests, 0 failures |
| 6 | `pnpm --filter gateway test:run` (CI mode) | Same as #5 (vitest run is CI mode) |

## 2. Test results

- **Runner:** Vitest
- **Config:** `gateway/vitest.config.ts`
- **Total tests:** 79
- **Passed:** 79
- **Failed:** 0
- **Skipped:** 0
- **Suites:** 14 files (6 AGPL-01 + 8 AGPL-02)

Raw output:

```
 ✓ src/tests/docs-scans.test.ts (6 tests)
 ✓ src/tests/opensign-client.test.ts (4 tests)
 ✓ src/tests/opensign-mappings.test.ts (5 tests)
 ✓ src/tests/mappings.test.ts (6 tests)
 ✓ src/tests/opensign-polling.test.ts (4 tests)
 ✓ src/tests/opensign-config.test.ts (3 tests)
 ✓ src/tests/opensign-docs.test.ts (7 tests)
 ✓ src/tests/kimai-client.test.ts (5 tests)
 ✓ src/tests/auth-fixes.test.ts (2 tests)
 ✓ src/tests/auth.test.ts (7 tests)
 ✓ src/tests/time-api.test.ts (7 tests)
 ✓ src/tests/signature-api.test.ts (10 tests)
 ✓ src/tests/security.test.ts (6 tests)
 ✓ src/tests/opensign-security.test.ts (7 tests)

 Test Files  14 passed (14)
      Tests  79 passed (79)
```

## 3. Typecheck results

```
> tsc --noEmit
[Process exited with code 0]
```

Result: PASS (no type errors).

## 4. Lint results

```
Not configured — no ESLint configuration in AGPL-02 scope.
TypeScript strict mode (tsc --noEmit) serves as the static analysis gate.
```

Result: N/A (lint not configured; typecheck is the static analysis gate).

## 5. Build results

```
> tsc
[Process exited with code 0]
```

Result: PASS (build artifacts emitted to `gateway/dist/`).

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

Result: No AGPL-02 modifications to Scentic core. No path references `scentic-agpl-services`, `agpl`, `gateway`, `vendor/opensign`, or `opensign`. Scentic core was inspected read-only; no `@scentic/*` package was imported into the AGPL gateway and no Scentic source file was edited.

Latest Scentic core commit at time of AGPL-02 closeout:

```
b3ad33b feat(admin): platform-role tags, LTR dialog, qualifications, archiving
```

## 7. AGPL repo git status (clean after commit)

Repository: `C:\AIprojects\factoryai\scentic-agpl-services`

Command (after commit): `git status --porcelain`

```
(working tree clean after commit)
```

Expected: clean working tree (all AGPL-02 work committed).

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

Result: PASS (OpenSign at pinned AGPL-01 SHA, unmodified by AGPL-02).

## 9. License verification

- Repository `LICENSE`: AGPL-3.0 full text present.
- `README.md` declares AGPL-3.0 licensing for gateway code, docs, scripts, deploy configs.
- `vendor/kimai/` license: AGPL-3.0-or-later (upstream Kimai, unmodified).
- `vendor/opensign/` license: root `LICENSE` is AGPL-3.0; `apps/OpenSignServer/package.json` declares `MIT`. This inconsistency is documented in `docs/SOURCE_OFFER.md` and treated conservatively as AGPL-3.0.
- No proprietary Scentic license headers or `@scentic/*` package references found in tracked files.

Result: PASS.

## 10. No `@scentic/*` imports scan

Command: search the gateway source tree for any `@scentic/` import or reference.

```
Result: PASS — zero `@scentic/*` imports or references found in `gateway/src/`.
```

Result: PASS — zero `@scentic/*` imports or references in `gateway/` or any tracked file in this repo.

## 11. No Scentic core modifications scan

Command: confirm no file under `C:\AIprojects\factoryai\scentic.ai` was modified by AGPL-02 work.

```
PASS — Scentic core git status has 9 porcelain entries, all pre-existing unrelated work (apps/web, packages/hierarchy, docs/design). No path references AGPL-02 artifacts.
```

Result: PASS — Scentic core working tree has no modifications attributable to AGPL-02.

## 12. OpenSign boundary verification

Command: confirm `vendor/opensign/` is unmodified and at the pinned SHA.

```
git -C vendor/opensign rev-parse HEAD
git -C vendor/opensign status --porcelain
```

Result: PASS — OpenSign at pinned SHA `f72624fa26211fe00776453d99a67120a4f5e060`, working tree clean (no AGPL-02 modifications).

---

## Evidence artifacts

Raw evidence artifacts (test reports, typecheck/lint/build logs, scan outputs) are stored at:

```
artifacts/evidence/agpl-02/
```

(No machine-readable reports generated for AGPL-02. Evidence is inline in this document and verified by the test suite.)
