# AGPL-3.0 Source Offer Compliance

> **Status:** Planning document (AGPL-00). The source offer endpoint and image labels are implemented in AGPL-05.
> **Scope:** Defines how this repository satisfies the AGPL-3.0 source-offer obligation for the Scentic AGPL services stack.

---

## 1. License summary

| Component | License | Source |
|---|---|---|
| This repository (`scentic-agpl-services`) | **AGPL-3.0** | `LICENSE` at repo root |
| Gateway code (Node.js/Express, original to this repo) | **AGPL-3.0** | `gateway/` |
| Kimai | **AGPL-3.0-or-later** | `vendor/kimai/` (upstream: https://github.com/kimai/kimai) |
| OpenSign | **AGPL-3.0** (treated conservatively; see §1.1) | `vendor/opensign/` (upstream: https://github.com/OpenSignLabs/OpenSign) |

AGPL-3.0 requires that anyone who conveys the software, or lets users interact with it over a network, must offer those users the complete corresponding source code, including any modifications, under AGPL-3.0. This document defines how Scentic satisfies that obligation for the AGPL services stack.

### 1.1 OpenSign license inconsistency

The vendored OpenSign source at `vendor/opensign/` carries **two conflicting license declarations**:

- `vendor/opensign/LICENSE` — the full GNU Affero General Public License v3.0 (AGPL-3.0) text.
- `vendor/opensign/apps/OpenSignServer/package.json` — `"license": "MIT"`.

This is an inconsistency in the upstream OpenSign project itself (present at the pinned upstream SHA `f72624fa26211fe00776453d99a67120a4f5e060`). Scentic treats OpenSign **conservatively as AGPL-3.0** for all source-offer, license-compliance, and contamination-analysis purposes, because:

1. The root `LICENSE` file is unambiguously the AGPL-3.0 text, and AGPL-3.0 is the license declared in OpenSign's public repository metadata and README.
2. AGPL-3.0 is the stricter of the two; treating the project as AGPL-3.0 satisfies both AGPL-3.0 and MIT obligations.
3. The `MIT` declaration in `package.json` appears to be an upstream packaging error and does not override the root `LICENSE`.

**Actions taken:**

- The `GET /source-offer` response and `docs/SOURCE_OFFER.md` list OpenSign as `AGPL-3.0`.
- `docs/SECURITY_THREAT_MODEL.md` (T-15) treats OpenSign as AGPL-3.0 for contamination analysis.
- This inconsistency is recorded here so reviewers and downstream consumers are aware that the upstream project's own declarations conflict. If the upstream project resolves the inconsistency in a future release, this section should be updated to reflect the resolved license.

---

## 2. What the source offer covers

The source offer covers all AGPL-licensed code and configuration required to build, run, and deploy the AGPL services stack:

- **Gateway code:** `gateway/` — the Node.js/Express service that bridges Scentic ↔ Kimai/OpenSign.
- **Kimai source:** `vendor/kimai/` — vendored copy of Kimai (AGPL-3.0-or-later), plus any patches in `patches/kimai/`.
- **OpenSign source:** `vendor/opensign/` — vendored copy of OpenSign (AGPL-3.0), plus any patches in `patches/opensign/`.
- **Deployment scripts:** `deploy/`, `scripts/` — Dockerfiles, compose files, GCloud deployment scripts, migration scripts.
- **Build instructions:** `docs/DEPLOYMENT.md` — how to build and run every component.
- **Connection manual:** `docs/SCENTIC_AGPL_CONNECTION_MANUAL.md` — how operators wire it up.
- **API contracts:** `docs/API_CONTRACTS.md` — the gateway API surface.
- **License text:** `LICENSE` at the repo root.

---

## 3. What the source offer does NOT cover

The source offer does **not** include, and is not required to include:

- **Scentic proprietary core** — the Scentic application, its services, packages, and modules. These are proprietary and are not part of this repository.
- **Scentic private packages** — any internal npm packages, libraries, or modules used by the Scentic core.
- **Secrets** — service tokens, API keys, database passwords, OAuth credentials, PFX private keys. All secrets come from secret stores; none are in the repo.
- **Client data** — firm records, matters, documents, user PII, signed envelopes. None of this is in the repo.
- **Production environment values** — actual `.env` values, production hostnames, internal IPs, Cloud SQL/MongoDB connection strings.

This separation is enforced by the dedicated GCP project (`scentic-agpl-prod`) and by the verification process in §9.

---

## 4. Source offer endpoint

The gateway exposes a machine-readable source offer:

```
GET /source-offer
200 OK
Content-Type: application/json
```

Response shape:

```json
{
  "license": "AGPL-3.0",
  "repository_url": "https://github.com/pulsehound/scentic-agpl-services",
  "license_text_url": "https://github.com/pulsehound/scentic-agpl-services/blob/main/LICENSE",
  "upstream": {
    "kimai": {
      "url": "https://github.com/kimai/kimai",
      "license": "AGPL-3.0-or-later",
      "vendored_path": "vendor/kimai/",
      "patches_path": "patches/kimai/"
    },
    "opensign": {
      "url": "https://github.com/OpenSignLabs/OpenSign",
      "license": "AGPL-3.0",
      "vendored_path": "vendor/opensign/",
      "patches_path": "patches/opensign/"
    }
  },
  "modifications": [
    {
      "component": "kimai",
      "description": "<short description or 'none'>",
      "patch_file": "patches/kimai/0001-<desc>.patch",
      "commit": "<sha or 'none'>"
    },
    {
      "component": "opensign",
      "description": "<short description or 'none'>",
      "patch_file": "patches/opensign/0001-<desc>.patch",
      "commit": "<sha or 'none'>"
    }
  ],
  "build_instructions_url": "https://github.com/pulsehound/scentic-agpl-services/blob/main/docs/DEPLOYMENT.md",
  "source_offer_doc_url": "https://github.com/pulsehound/scentic-agpl-services/blob/main/docs/SOURCE_OFFER.md",
  "offer_validity": "At least 3 years from the date of each corresponding release, per AGPL-3.0 §6(b)."
}
```

The endpoint is unauthenticated (it returns only metadata, no secrets or user data) and is reachable over the same internal route as the gateway. A public mirror of the same JSON is published at the public repository URL.

---

## 5. Source code publication strategy

- **Public Git repository:** The gateway code, deployment scripts, docs, and patch files are published in a public Git repository at `https://github.com/pulsehound/scentic-agpl-services`. This is the canonical source-offer location.
- **Upstream already public:** Kimai (https://github.com/kimai/kimai) and OpenSign (https://github.com/OpenSignLabs/OpenSign) are already public upstream repositories. The source offer links to them directly.
- **Forks and patches published alongside the gateway code:**
  - Any patches to Kimai or OpenSign are stored as patch files under `patches/kimai/` and `patches/opensign/` in this repository and applied at build time (see `scripts/apply-patches.sh`).
  - Alternatively, forks of Kimai/OpenSign live as branches in this repository or as referenced public forks. The `modifications` field of the source-offer response points to the exact patch file or fork branch.
- **Version pinning:** Each release tag in this repository pins the exact upstream Kimai/OpenSign commit it vendors, recorded in `vendor/kimai/UPSTREAM_COMMIT` and `vendor/opensign/UPSTREAM_COMMIT`.

---

## 6. Docker image labels

Every container image produced from this repository carries OpenContainers labels declaring the license and source URL:

```dockerfile
LABEL org.opencontainers.image.license="AGPL-3.0"
LABEL org.opencontainers.image.source="https://github.com/pulsehound/scentic-agpl-services"
LABEL org.opencontainers.image.title="scentic-agpl-<service>"
LABEL org.opencontainers.image.description="<service description>"
LABEL org.opencontainers.image.url="https://github.com/pulsehound/scentic-agpl-services"
```

Images affected:

- `gateway/Dockerfile` → gateway image
- `deploy/kimai/Dockerfile` (if a derived Kimai image is built) → Kimai image with patches applied
- `deploy/opensign/Dockerfile` (if a derived OpenSign image is built) → OpenSign image with patches applied

Labels are inspected with `docker image inspect <image>` and are preserved when pushed to Artifact Registry.

---

## 7. Upstream attribution

- **Kimai:** https://github.com/kimai/kimai — Kimai project, AGPL-3.0-or-later. Attribution retained in `vendor/kimai/README.md` and the Kimai UI footer per the upstream license.
- **OpenSign:** https://github.com/OpenSignLabs/OpenSign — OpenSignLabs, AGPL-3.0. Attribution retained in `vendor/opensign/README.md`.

Both upstream `LICENSE` files are preserved verbatim under `vendor/kimai/LICENSE` and `vendor/opensign/LICENSE`.

---

## 8. Modified upstream tracking

Any modification to Kimai or OpenSign is tracked in one of two ways, and recorded in the `modifications` list of the source-offer response (§4):

### Option A — Patch files (preferred for small, surgical changes)

- Patch files live in `patches/kimai/` and `patches/opensign/`.
- Naming: `patches/<component>/NNNN-<short-description>.patch` (e.g., `patches/kimai/0001-scentic-sso.patch`).
- Applied at build time by `scripts/apply-patches.sh` against the vendored upstream commit recorded in `vendor/<component>/UPSTREAM_COMMIT`.
- Each patch file includes a header describing the purpose, author, and date.

### Option B — Fork branches (for larger divergences)

- A fork of the upstream lives as a branch in this repository (e.g., `forks/kimai-scentic`) or as a referenced public fork.
- The fork branch tracks a clear upstream merge-base, recorded in the modification log below.

### Modification log

Append a row here whenever a modification is added. Until AGPL-05 lands, this list is empty.

| Date | Component | Type | Reference | Description |
|---|---|---|---|---|
| _(none yet)_ | | | | |

---

## 9. No Scentic proprietary code in AGPL source — verification process

To guarantee the AGPL source offer never includes Scentic proprietary code:

1. **Repository boundary:** The `scentic-agpl-services` repository contains only AGPL-licensed code, vendored upstreams, deployment scripts, and docs. The Scentic proprietary core lives in a separate repository and is never vendored or copied here.
2. **Pre-commit hook / CI check:** A scan runs on every PR and on release builds that asserts:
   - No imports from `@scentic/*` private packages exist in `gateway/`, `deploy/`, or `scripts/`.
   - No file paths under a configured proprietary directory list appear in the repo.
   - No Scentic-internal hostnames, internal IPs, or `.env` values appear in tracked files.
3. **License scan:** A license scan (e.g., `license-checker` / `reuse lint`) runs in CI and fails if any dependency introduces a license incompatible with AGPL-3.0, or if any file lacks a valid license header where one is required.
4. **Secret scan:** A secret scan (e.g., `gitleaks`) runs on every PR and on release builds and fails on any detected secret.
5. **Build reproducibility:** Building from the public repository with `docs/DEPLOYMENT.md` must reproduce a functionally identical AGPL stack without any Scentic proprietary artifacts.
6. **Manual review at release:** Before tagging a release, a reviewer confirms the source-offer response (`GET /source-offer`) matches the actual repo contents and that no proprietary code has been added since the last release.

---

## 10. License notice for README and UI

### README notice (required)

The repository `README.md` must include the following notice block:

```
scentic-agpl-services is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
See LICENSE for the full text.

This repository vendors:
  - Kimai (AGPL-3.0-or-later) — https://github.com/kimai/kimai
  - OpenSign (AGPL-3.0)       — https://github.com/OpenSignLabs/OpenSign

Source offer: GET /source-offer on the gateway, or see docs/SOURCE_OFFER.md.
All modifications to upstream projects are published in this repository under patches/
and documented in docs/SOURCE_OFFER.md.
```

### UI / runtime notice (required)

- **Gateway:** `GET /source-offer` returns the machine-readable source offer (§4). The gateway additionally prints the license + source URL at startup.
- **Kimai UI:** Kimai's own AGPL notice and footer attribution are retained unmodified.
- **OpenSign UI:** OpenSign's own AGPL notice is retained unmodified.
- **Docker images:** The `org.opencontainers.image.license=AGPL-3.0` label is present on every image (§6), inspectable without running the container.

### Footer text for any user-facing AGPL UI page provided by this stack

```
Powered by Kimai (AGPL-3.0-or-later) and OpenSign (AGPL-3.0).
Source code and modifications: https://github.com/pulsehound/scentic-agpl-services
```

---

## References

- `LICENSE` — full AGPL-3.0 text.
- `vendor/kimai/LICENSE` — Kimai upstream license.
- `vendor/opensign/LICENSE` — OpenSign upstream license.
- `docs/DEPLOYMENT.md` — build and deployment instructions.
- `docs/NEXT_STEPS.md` — AGPL-05 implements this document.
