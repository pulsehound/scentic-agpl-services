# Upstream Sources

**Last updated:** 2026-07-31

This document records the exact upstream sources used in `scentic-agpl-services`.

## Kimai

| Field | Value |
|-------|-------|
| Upstream URL | https://github.com/kimai/kimai |
| Cloned commit SHA | `7c2ed4b07cca2e15b1ab4cc5947afdf899a76401` |
| License | AGPL-3.0-or-later |
| Local path | `vendor/kimai/` |
| Clone command | `git clone --depth 1 https://github.com/kimai/kimai.git vendor/kimai` |
| Stack | PHP 8.2+, Symfony 6, MySQL/MariaDB |

### Reproducing the exact checkout

```bash
git clone https://github.com/kimai/kimai.git vendor/kimai
cd vendor/kimai
git checkout 7c2ed4b07cca2e15b1ab4cc5947afdf899a76401
```

Or with shallow clone:
```bash
git clone --depth 1 https://github.com/kimai/kimai.git vendor/kimai
cd vendor/kimai
git fetch --depth 1 origin 7c2ed4b07cca2e15b1ab4cc5947afdf899a76401
git checkout 7c2ed4b07cca2e15b1ab4cc5947afdf899a76401
```

## OpenSign

| Field | Value |
|-------|-------|
| Upstream URL | https://github.com/OpenSignLabs/OpenSign |
| Cloned commit SHA | `f72624fa26211fe00776453d99a67120a4f5e060` |
| License | AGPL-3.0 |
| Local path | `vendor/opensign/` |
| Clone command | `git clone --depth 1 https://github.com/OpenSignLabs/OpenSign.git vendor/opensign` |
| Stack | React 19, Parse Server 8, Express 5, MongoDB |

### Reproducing the exact checkout

```bash
git clone https://github.com/OpenSignLabs/OpenSign.git vendor/opensign
cd vendor/opensign
git checkout f72624fa26211fe00776453d99a67120a4f5e060
```

Or with shallow clone:
```bash
git clone --depth 1 https://github.com/OpenSignLabs/OpenSign.git vendor/opensign
cd vendor/opensign
git fetch --depth 1 origin f72624fa26211fe00776453d99a67120a4f5e060
git checkout f72624fa26211fe00776453d99a67120a4f5e060
```

## Vendor directory policy

- `vendor/` is **gitignored** and not committed to the AGPL repo
- Upstream repos are cloned by `scripts/setup.sh` and updated by `scripts/update-vendor.sh`
- No modifications to upstream code are made unless we intentionally decide to fork
- If we fork, modifications will be tracked as patch files in `patches/` or as fork branches
- The AGPL source offer covers the gateway code; upstream Kimai and OpenSign are already public

## Source-offer implications

1. The gateway code (in `gateway/`) is the primary AGPL-licensed work in this repo
2. Upstream Kimai and OpenSign are available at their public URLs (pinned above)
3. Any modifications to upstream code will be published alongside the gateway code
4. Docker images will include OCI labels pointing to this repo and upstream URLs
5. No Scentic proprietary code is included in the AGPL source offer
