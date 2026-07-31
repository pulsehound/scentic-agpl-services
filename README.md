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

## License

- **This repository (gateway code, docs, scripts, deploy configs):** AGPL-3.0
- **vendor/kimai/:** AGPL-3.0-or-later (upstream Kimai, unmodified)
- **vendor/opensign/:** AGPL-3.0 (upstream OpenSign, unmodified)
- See `LICENSE` for the full AGPL-3.0 text.
- See `docs/SOURCE_OFFER.md` for attribution and modification tracking.

## Status

**Phase AGPL-02: OPENSIGN INTEGRATION FOUNDATION COMPLETE**

The gateway skeleton, Kimai integration foundation (AGPL-01), and OpenSign integration foundation (AGPL-02) are implemented in `gateway/` (Node.js/Express/TypeScript with Vitest tests). AGPL-02 adds an OpenSign API client (Parse Server REST, endpoints verified against `vendor/opensign/` source), an OpenSign service with firm-scoped operations and a polling completion-detection model, 11 signature REST endpoints, extended mapping store (OpenSign Firm/User/Workflow/Signer), 12 OpenSign event types in the outbox, and config/env validation for OpenSign. AGPL-01 fixes carried in: auth middleware path-firm check (`extractFirmIdFromPath`), bodyless request canonical hash documented. OpenSign unsupported operations documented (manual reminders `NOT_SUPPORTED`, no native void/cancel — uses `declinedoc`, no native webhooks — polling).

Carried gaps (to resolve before AGPL-04 production readiness): per-user OpenSign session tokens (currently uses master key), persistent mapping store (in-memory), real-OpenSign container contract test (mock-only), webhook dispatch to Scentic (AGPL-03).

Scentic core was NOT modified (read-only inspection only). OpenSign upstream was NOT modified (at pinned SHA `f72624fa26211fe00776453d99a67120a4f5e060`).

See `docs/AGPL_02_CLOSEOUT.md` for the AGPL-02 closeout.
See `docs/AGPL_02_EVIDENCE.md` for executed evidence.
See `docs/AGPL_01_CLOSEOUT.md` for the AGPL-01 closeout.
See `docs/SCENTIC_AGPL_INTEGRATION_PLAN.md` for the complete plan.
See `docs/NEXT_STEPS.md` for implementation roadmap (AGPL-03 is next).
