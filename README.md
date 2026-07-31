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

**Phase AGPL-03: LOCAL DEPLOYMENT + CONNECTION INTERFACE READY**

The gateway skeleton, Kimai integration foundation (AGPL-01), OpenSign integration foundation (AGPL-02), and AGPL-03 (local deployment + connection interface) are delivered. AGPL-03 adds a webhook dispatcher (`gateway/src/events/webhook-dispatcher.ts`) that signs outbound webhooks to Scentic with HMAC-SHA256, retries with exponential backoff, and is disabled safely when the target URL/secret is not configured; a webhook signer (`gateway/src/events/webhook-signer.ts`) with `X-Gateway-*` headers and constant-time verification; a local docker-compose stack (`deploy/docker-compose.yml`) running gateway + Kimai + OpenSign + MongoDB + MariaDB; and the complete Scentic ↔ AGPL interface documentation (`docs/SCENTIC_INTERFACE_SPEC.md`, `docs/SCENTIC_CORE_REQUIRED_CHANGES.md`, `docs/SCENTIC_ENV_VARS_REQUIRED.md`).

**Scentic core was NOT modified.** AGPL-03 is documentation-only on the Scentic side: the full set of Scentic-core changes (new `AGPL_GATEWAY` signature provider type, env-schema validation, webhook receiver route, time-tracking proxy routes, provider-health entry, audit events) is specified in `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` for Yair to land when he decides to integrate. No Scentic proprietary file was edited (read-only inspection only). OpenSign and Kimai upstream remain unmodified.

Carried gaps (to resolve before AGPL-04 production readiness): Scentic-core-side implementation of `docs/SCENTIC_CORE_REQUIRED_CHANGES.md` (lands on Yair's approval), per-user Kimai/OpenSign tokens (currently admin/master-key fallback), persistent mapping/nonce/idempotency stores (in-memory), real-Kimai and real-OpenSign container contract tests (mock-only), production deployment (AGPL-04).

See `docs/AGPL_03_CLOSEOUT.md` for the AGPL-03 closeout.
See `docs/AGPL_03_EVIDENCE.md` for executed evidence.
See `docs/AGPL_02_CLOSEOUT.md` for the AGPL-02 closeout.
See `docs/AGPL_01_CLOSEOUT.md` for the AGPL-01 closeout.
See `docs/SCENTIC_AGPL_INTEGRATION_PLAN.md` for the complete plan.
See `docs/NEXT_STEPS.md` for implementation roadmap (AGPL-04 is next).
