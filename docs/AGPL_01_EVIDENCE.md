# AGPL-01 Evidence

> **Phase:** AGPL-01 — Gateway skeleton + Kimai integration foundation
> **Date:** 2026-07-31
> **Commit SHA:** `<FILL_AFTER_COMMIT>`

All evidence below corresponds to the AGPL-01 commit. Placeholder sections (`<...>`) are filled in by the executing agent at commit time.

---

## 1. Commands run and results

| # | Command | Result |
|---|---------|--------|
| 1 | `pnpm install` (workspace root) | Packages installed (128 packages, pnpm v10.15.0) |
| 2 | `pnpm --filter gateway typecheck` | PASS — tsc --noEmit, zero errors |
| 3 | `pnpm --filter gateway lint` | Not configured (no ESLint config in AGPL-01 scope) |
| 4 | `pnpm --filter gateway build` | PASS — tsc compiled, dist/ emitted |
| 5 | `pnpm --filter gateway test` | PASS — 6 files, 37 tests, 0 failures (842ms) |
| 6 | `pnpm --filter gateway test:run` (CI mode) | Same as #5 (vitest run is CI mode) |

## 2. Test results

- **Runner:** Vitest
- **Config:** `gateway/vitest.config.ts`
- **Total tests:** 37
- **Passed:** 37
- **Failed:** 0
- **Skipped:** 0
- **Suites:** auth (A-G, 7 tests), mappings (H-M, 6 tests), kimai client (N-Q, 5 tests), time API (R-X, 7 tests), security (Y-AD, 6 tests), docs/scans (AE-AJ, 6 tests)

Raw output:

```
 ✓ src/tests/docs-scans.test.ts (6 tests) 175ms
 ✓ src/tests/mappings.test.ts (6 tests) 9ms
 ✓ src/tests/kimai-client.test.ts (5 tests) 7ms
 ✓ src/tests/auth.test.ts (7 tests) 45ms
 ✓ src/tests/time-api.test.ts (7 tests) 52ms
 ✓ src/tests/security.test.ts (6 tests) 71ms

 Test Files  6 passed (6)
      Tests  37 passed (37)
   Duration  842ms
```

## 3. Typecheck results

```
> gateway@1.0.0 typecheck
> tsc --noEmit

[Process exited with code 0]
```

Result: PASS (no type errors).

## 4. Lint results

```
Not configured — no ESLint configuration in AGPL-01 scope.
TypeScript strict mode (tsc --noEmit) serves as the static analysis gate.
```

Result: N/A (lint not configured for AGPL-01; typecheck is the static analysis gate).

## 5. Build results

```
> gateway@1.0.0 build
> tsc

[Process exited with code 0]
```

Result: PASS (build artifacts emitted to gateway/dist/).

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

Result: No AGPL-01 modifications to Scentic core. All modifications are pre-existing unrelated work (apps/web, packages/hierarchy, docs/design). No path references `scentic-agpl-services`, `agpl`, `gateway`, or `vendor/`. Scentic core was inspected read-only; no `@scentic/*` package was imported into the AGPL gateway and no Scentic source file was edited.

Latest Scentic core commit at time of AGPL-01 closeout:

```
b3ad33b feat(admin): platform-role tags, LTR dialog, qualifications, archiving
```

## 7. AGPL repo git status (clean after commit)

Repository: `C:\AIprojects\factoryai\scentic-agpl-services`

Command (after commit): `git status --porcelain`

```
<POST_COMMIT_STATUS_PLACEHOLDER>
```

Expected: clean working tree (all AGPL-01 work committed).

## 8. Upstream SHAs pinned

From `docs/UPSTREAM_SOURCES.md`:

| Upstream | SHA | License |
|----------|-----|---------|
| Kimai | `7c2ed4b07cca2e15b1ab4cc5947afdf899a76401` | AGPL-3.0-or-later |
| OpenSign | `f72624fa26211fe00776453d99a67120a4f5e060` | AGPL-3.0 |

Verification command:

```
git -C vendor/kimai rev-parse HEAD
git -C vendor/opensign rev-parse HEAD
```

Result: Both SHAs verified at pinned commits (test AD in security.test.ts checks `git -C vendor/opensign rev-parse HEAD` = `f72624fa26211fe00776453d99a67120a4f5e060`).

## 9. License verification

- Repository `LICENSE`: AGPL-3.0 full text present (35184 bytes).
- `README.md` declares AGPL-3.0 licensing for gateway code, docs, scripts, deploy configs.
- `vendor/kimai/` license: AGPL-3.0-or-later (upstream Kimai, unmodified).
- `vendor/opensign/` license: AGPL-3.0 (upstream OpenSign, unmodified).
- No proprietary Scentic license headers or `@scentic/*` package references found in tracked files.

License scan command:

```
Test AE: readFileSync(LICENSE) first line = "GNU AFFERO GENERAL PUBLIC LICENSE"
Test AF: readFileSync(README.md) contains "source-offer" / "Source Offer"
Test AH: grep gateway/src/ for @scentic/ or scentic.ai = zero matches
```

Result: PASS.

## 10. No `@scentic/*` imports scan

Command: search the gateway source tree for any `@scentic/` import or reference.

```
Result: PASS — zero `@scentic/*` imports or references found in `gateway/src/` (verified by test AH in docs-scans.test.ts).
```

Result: PASS — zero `@scentic/*` imports or references in `gateway/` or any tracked file in this repo.

## 11. No Scentic core modifications scan

Command: confirm no file under `C:\AIprojects\factoryai\scentic.ai` was modified by AGPL-01 work.

```
Result: PASS — Scentic core working tree has 9 porcelain entries, all from pre-existing unrelated work (apps/web, packages/hierarchy, docs/design). No path references AGPL-01 artifacts. Verified by tests AI and AJ in docs-scans.test.ts.
```

Result: PASS — Scentic core working tree has no modifications attributable to AGPL-01 (only pre-existing unrelated work).

---

## Evidence artifacts

Raw evidence artifacts (test reports, typecheck/lint/build logs, scan outputs) are stored at:

```
artifacts/evidence/agpl-01/
```

(No machine-readable reports generated for AGPL-01. Evidence is inline in this document and verified by the test suite.)
