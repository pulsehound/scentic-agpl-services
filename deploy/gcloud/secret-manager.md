<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- scentic-agpl-services — GCloud Secret Manager reference setup -->

# Secret Manager Setup (Reference Only)

> **Status:** REFERENCE ONLY. No GCP project provisioned. Do not execute these commands without project-owner authorization.
>
> **Scope:** The secrets required by the gateway Cloud Run service. Kimai and OpenSign server-side secrets are documented in `docs/DEPLOYMENT.md` §5.

---

## 1. Required gateway secrets

All values are strong, randomly generated, non-placeholder secrets stored in Cloud Secret Manager. Secret names are **not** themselves secret; the values are.

| Secret name | Purpose | Used by | Rotated |
|---|---|---|---|
| `SCENTIC_SHARED_HMAC_SECRET` | Shared HMAC secret verifying service-to-service requests from Scentic core (Scentic → Gateway). Distinct from the webhook secret. | gateway | 90 days |
| `SCENTIC_WEBHOOK_HMAC_SECRET` | HMAC secret signing outbound webhook payloads dispatched from the gateway to Scentic core (Gateway → Scentic). Distinct from the shared HMAC secret. | gateway | 90 days |
| `KIMAI_ADMIN_API_TOKEN` | Kimai admin API token used by the gateway as the fallback credential when a per-user Kimai API token is not yet provisioned. | gateway | 90 days |
| `OPENSIGN_MASTER_KEY` | OpenSign Parse Server master key. Server-side only; never sent to Scentic; never logged. | gateway + OpenSign server | 90 days (provisioning only after lock-down) |
| `OPENSIGN_ADMIN_PASSWORD` | OpenSign admin account password used by the gateway to log in and obtain a session token. | gateway | 90 days |

> The two HMAC secrets MUST be distinct values. Never reuse the same secret for `SCENTIC_SHARED_HMAC_SECRET` and `SCENTIC_WEBHOOK_HMAC_SECRET`. See `docs/SECURITY_THREAT_MODEL.md` (T-03, T-04) and `deploy/secrets.example.md`.

## 2. Creating the secrets (reference commands)

> **Do not execute without authorization.** Replace `PROJECT_ID` and the placeholder secret values with real, strong, randomly generated values before any real provisioning. The `--data-file=-` form reads the secret value from stdin so it is not written to shell history.

```bash
# Set the project (replace PROJECT_ID).
gcloud config set project PROJECT_ID

# 1. SCENTIC_SHARED_HMAC_SECRET (signs Scentic → Gateway requests)
printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets create SCENTIC_SHARED_HMAC_SECRET \
    --replication-policy="automatic" \
    --data-file=-

# 2. SCENTIC_WEBHOOK_HMAC_SECRET (signs Gateway → Scentic webhooks)
#    MUST be a distinct value from SCENTIC_SHARED_HMAC_SECRET.
printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets create SCENTIC_WEBHOOK_HMAC_SECRET \
    --replication-policy="automatic" \
    --data-file=-

# 3. KIMAI_ADMIN_API_TOKEN (Kimai admin API token fallback)
printf '%s' "<strong-kimai-admin-api-token>" | \
  gcloud secrets create KIMAI_ADMIN_API_TOKEN \
    --replication-policy="automatic" \
    --data-file=-

# 4. OPENSIGN_MASTER_KEY (Parse master key — server-side only)
printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets create OPENSIGN_MASTER_KEY \
    --replication-policy="automatic" \
    --data-file=-

# 5. OPENSIGN_ADMIN_PASSWORD (OpenSign admin account password)
printf '%s' "<strong-opensign-admin-password>" | \
  gcloud secrets create OPENSIGN_ADMIN_PASSWORD \
    --replication-policy="automatic" \
    --data-file=-
```

## 3. Rotating a secret (reference)

```bash
# Create a new version of an existing secret (new value from stdin).
printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets versions add SCENTIC_SHARED_HMAC_SECRET \
    --data-file=-

# Pin the Cloud Run service to the new version (redeploy the service manifest
# with the desired key, or update the service). See deploy-commands.md.
```

The gateway supports a dual-secret overlap window during rotation (planned). During rotation: create the new Secret Manager version, add the new value to the gateway's accepted-secrets set (overlap window), update Scentic's Secret Manager reference, roll Scentic instances, then drop the old version after the overlap window expires. See `docs/SCENTIC_ENV_VARS_REQUIRED.md` §4 and `deploy/secrets.example.md`.

## 4. Referencing secrets in Cloud Run

Cloud Run can consume Secret Manager secrets in two ways:

### 4.1 Env var reference (used in `cloud-run-gateway.yaml`)

Mount the secret as an environment variable via `valueFrom.secretKeyRef`:

```yaml
env:
  - name: SCENTIC_SHARED_HMAC_SECRET
    valueFrom:
      secretKeyRef:
        name: SCENTIC_SHARED_HMAC_SECRET
        key: latest
```

### 4.2 Mounted file volume (alternative)

For secrets that are files (e.g. PFX certificates), mount as a volume:

```yaml
volumes:
  - name: opensign-pfx
    secret:
      secretName: OPENSIGN_PFX_CERTIFICATE
      items:
        - key: latest
          path: opensign.pfx
```

Then read the file from `/secrets/opensign-pfx/opensign.pfx` in the container.

## 5. Granting the gateway service account access

The gateway runtime service account must be granted `roles/secretmanager.secretAccessor` on each secret it needs. Grant per-secret (least privilege), not project-wide. See `service-accounts.md`.

```bash
# Replace PROJECT_ID and GATEWAY_SA.
for SECRET in \
  SCENTIC_SHARED_HMAC_SECRET \
  SCENTIC_WEBHOOK_HMAC_SECRET \
  KIMAI_ADMIN_API_TOKEN \
  OPENSIGN_MASTER_KEY \
  OPENSIGN_ADMIN_PASSWORD ; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:GATEWAY_SA@PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

## 6. Hard rules

- No secrets in the repository.
- No secrets in `.env` files committed to git (only `.env.example` / `deploy/env.example` with placeholders).
- No secrets baked into container images.
- `SCENTIC_SHARED_HMAC_SECRET` and `SCENTIC_WEBHOOK_HMAC_SECRET` MUST be distinct values.
- All `*_HMAC_SECRET`, `KIMAI_ADMIN_API_TOKEN`, `OPENSIGN_MASTER_KEY`, and `OPENSIGN_ADMIN_PASSWORD` values must be strong, non-placeholder values in production (the gateway's `config.ts` rejects placeholders when `NODE_ENV=production`).
- Rotate HMAC secrets and admin credentials every 90 days.

## 7. Related files

- `deploy/gcloud/cloud-run-gateway.yaml` — references all five secrets above.
- `deploy/gcloud/service-accounts.md` — least-privilege service account setup.
- `deploy/secrets.example.md` — canonical gateway secret naming + aliases + rotation policy.
- `docs/DEPLOYMENT.md` §5 — full secrets management plan (Kimai + OpenSign server-side secrets included).
- `docs/SCENTIC_ENV_VARS_REQUIRED.md` §4 — rotation procedure (Scentic side).
- `docs/SECURITY_THREAT_MODEL.md` — T-03 / T-04 / T-16 mitigation notes.
