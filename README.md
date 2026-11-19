# scentic-agpl-services

**AGPL-3.0 Licensed** — Scentic AGPL Integration Stack

This repository contains the AGPL-licensed integration services that bridge the proprietary Scentic.ai legal operating system with two AGPL-licensed upstream applications:

- [Kimai](https://github.com/kimai/kimai) — AGPL-3.0 time-tracking
- [OpenSign](https://github.com/OpenSignLabs/OpenSign) — AGPL-3.0 e-signature

## Purpose

Scentic core (`scentic.ai`) is a proprietary legal operating system. This repo provides a **separate AGPL integration stack** so that Scentic can use Kimai for time tracking and OpenSign for e-signatures without importing AGPL code or AGPL dependencies into the proprietary Scentic core.

**Architecture:**

```
Scentic core (proprietary)
  |
  | REST / webhook / API only
  v
scentic-agpl-services gateway (AGPL)
  |                         |
  v                         v
Kimai (AGPL)            OpenSign (AGPL)
```

The gateway is the only custom Scentic-facing service. Scentic core communicates with the gateway through stable REST/webhook API contracts. The gateway communicates with Kimai and OpenSign.

## What this repo contains

| Directory | Contents |
|-----------|----------|
| `gateway/` | Custom Scentic-facing bridge service (API, auth, mappings, webhooks, source-offer) |
| `vendor/kimai/` | Upstream Kimai source (git clone, shallow) |
| `vendor/opensign/` | Upstream OpenSign source (git clone, shallow) |
| `deploy/` | Docker Compose, GCloud deployment configs, env examples |
| `docs/` | Integration plan, API contracts, mapping docs, deployment guide, security threat model |
| `scripts/` | Setup and maintenance scripts |

## What this repo does NOT contain

- Scentic proprietary core code
- Scentic private packages (`@scentic/*`)
- Any proprietary Scentic logic
- Production secrets or credentials
- Client or legal data

## Source Offer (AGPL-3.0 Compliance)

This repository is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). As required by AGPL-3.0 Section 13, anyone who interacts with this software remotely through a network has the right to receive the complete corresponding source code.

**How to obtain source:**

1. This repository is the complete source for the gateway code.
2. Upstream Kimai source is in `vendor/kimai/` (originally from https://github.com/kimai/kimai).
3. Upstream OpenSign source is in `vendor/opensign/` (originally from https://github.com/OpenSignLabs/OpenSign).
4. Any modifications to Kimai or OpenSign are tracked as patch files or fork branches.
5. Deployment scripts (excluding secrets) are in `deploy/` and `scripts/`.
6. Build instructions are in `docs/DEPLOYMENT.md`.

**What the source offer does NOT include:**

- Scentic proprietary core (not AGPL-licensed, not part of this repo)
- Production secrets, credentials, or environment values
- Client data, legal documents, or production database contents

See `docs/SOURCE_OFFER.md` for full details.

## Tests

```
pnpm install
pnpm test            # everything below
pnpm test:gateway    # the gateway (gateway/src/tests)
pnpm test:patches    # what this repository changes in OpenSign at image build (deploy/tests)
```

`deploy/tests` covers the parts that are applied to OpenSign when its images are built:

| Suite | What it runs |
|-------|--------------|
| `server-patches.test.mjs` | Every edit in `deploy/opensign-server-patches.mjs` over a copy of the **real upstream server source** in `vendor/opensign` (fetched by `scripts/update-vendor.sh`, not committed): each applies to exactly one place, a second run is refused edit by edit, and every patched file still parses. Skipped, saying why, when `vendor/opensign` is not on disk. |
| `frontend-patches.test.mjs` | Every transform in `deploy/opensign-frontend-patches.mjs` over text cut from the built signing page, the whole script over a small build folder laid out like it, and the hashes of the third-party files in `deploy/opensign-assets/vendor`. The page exists only built, inside the upstream image, so the proof that the real page takes the patch is the image build below. |
| `ceremony.test.mjs` | `deploy/opensign-ceremony/scentic-ceremony.js` in jsdom against a page shaped like the signing page: the bar and Start, what Start never clicks, and what the bar says once a document is declined, expired, withdrawn or finished. |
| `certificate.test.mjs` | The patched certificate generator, run on fixture documents; the text of the PDFs it makes is read back. |

Building the images runs the same scripts for real and fails if any edit does not apply. The signing page's build also fails if the page still names a host it used to load from:

```
docker build -f deploy/Dockerfile.opensign -t local/opensign:test .
docker build -f deploy/Dockerfile.opensign-server -t local/opensign-server:test .
```

Both default to base images in the project's registry; `--build-arg OPENSIGN_FONT_SOURCE=…` (page) and `--build-arg OPENSIGN_BASE=…` (server) name others.

One gateway suite talks to a real PostgreSQL when told where one is, and is skipped otherwise: `CONTRACT_POSTGRES_URL=postgres://user:pass@host:port/db pnpm test:gateway` (an empty, throwaway database).

## License

- **This repository (gateway code, docs, scripts, deploy configs):** AGPL-3.0
- **vendor/kimai/:** AGPL-3.0-or-later (upstream Kimai, unmodified)
- **vendor/opensign/:** AGPL-3.0 (upstream OpenSign, unmodified)
- See `LICENSE` for the full AGPL-3.0 text.
- See `docs/SOURCE_OFFER.md` for attribution and modification tracking.

## Status

**Phase AGPL-05: POSTGRES DURABLE STORE + FINAL DEPLOYMENT PACKAGE**

AGPL-01 through AGPL-05 are delivered. AGPL-05 replaces the Docker SQLite fallback with Postgres (pg, pure JS, no native modules), adds a mock Scentic webhook receiver for local testing, and produces the final operator handoff and connection manual.

**Scentic core was NOT modified.** All phases are gateway + docs only.

**Final classification:** AGPL SERVICES LOCAL DEPLOYMENT PACKAGE COMPLETE / PRODUCTION DEPLOYMENT NOT EXECUTED / SCENTIC CORE INTEGRATION NOT APPLIED

See `docs/AGPL_DEPLOYMENT_HANDOFF.md` for the final deployment handoff.
See `docs/FINAL_OPERATOR_CHECKLIST.md` for the operator checklist.
See `docs/PRODUCTION_BLOCKERS.md` for production blockers.
See `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` for the operator-facing connection manual.
See `docs/AGPL_05_CLOSEOUT.md` for the AGPL-05 closeout.
See `docs/AGPL_04_CLOSEOUT.md` for the AGPL-04 closeout.
See `docs/AGPL_03_CLOSEOUT.md` for the AGPL-03 closeout.
See `docs/AGPL_02_CLOSEOUT.md` for the AGPL-02 closeout.
See `docs/AGPL_01_CLOSEOUT.md` for the AGPL-01 closeout.
See `docs/SCENTIC_AGPL_INTEGRATION_PLAN.md` for the complete plan.
