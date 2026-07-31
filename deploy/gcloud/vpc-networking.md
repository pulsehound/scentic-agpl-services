<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- scentic-agpl-services — GCloud VPC + private networking reference -->

# VPC Configuration (Reference Only)

> **Status:** REFERENCE ONLY. No GCP project provisioned. Do not execute these commands without project-owner authorization.

---

## 1. Purpose

The gateway (Cloud Run) needs private-network reachability to:

- **Kimai** (Cloud Run or GCE) — REST API over HTTP.
- **OpenSign server** (Cloud Run or GCE) — Parse Server REST API over HTTP.
- **Cloud SQL Postgres** (private IP) — the gateway durable store (mapping/nonce/outbox tables).
- **MongoDB** (Atlas peered into the AGPL VPC, or self-hosted on GCE) — used by OpenSign, not directly by the gateway.

Cloud Run is serverless and does not live inside a VPC by default. A **Serverless VPC Access connector** gives the Cloud Run revision a private-network egress path into the AGPL VPC. The connector is configured in `cloud-run-gateway.yaml` via `run.googleapis.com/vpc-access-connector`, with egress set to `private-ip-only` so only private-IP destinations are routed through the VPC.

## 2. VPC + subnet (reference)

```bash
# Replace PROJECT_ID and REGION.
# Create a custom VPC for the AGPL stack.
gcloud compute networks create scentic-agpl-vpc \
  --subnet-mode=custom \
  --project=PROJECT_ID

# Create a subnet in the target region (e.g. 10.20.0.0/20).
gcloud compute networks subnets create agpl-subnet \
  --network=scentic-agpl-vpc \
  --region=REGION \
  --range=10.20.0.0/20 \
  --enable-private-ip-google-access \
  --project=PROJECT_ID
```

`--enable-private-ip-google-access` enables **Private Google Access** so resources with only private IPs can reach Google APIs (e.g., Secret Manager, Artifact Registry, Cloud SQL admin APIs) without public IPs. See §5.

## 3. Serverless VPC Access connector (reference)

```bash
# Replace PROJECT_ID, REGION, and the connector name.
# The connector range must NOT overlap with any existing subnet range.
gcloud compute networks vpc-access connectors create scentic-agpl-connector \
  --network=scentic-agpl-vpc \
  --region=REGION \
  --range=10.30.0.0/28 \
  --project=PROJECT_ID
```

Reference the connector in `cloud-run-gateway.yaml`:

```yaml
run.googleapis.com/vpc-access-connector: projects/PROJECT_ID/regions/REGION/connectors/scentic-agpl-connector
run.googleapis.com/vpc-access-egress: private-ip-only
```

## 4. Firewall rules for internal traffic

Internal traffic between the gateway, Kimai, OpenSign, Cloud SQL (private IP), and MongoDB stays inside the AGPL VPC. Restrictive firewall rules keep it there.

```bash
# Replace PROJECT_ID and adjust CIDRs to the actual subnet ranges.

# Allow internal HTTP/HTTPS between AGPL services (gateway -> kimai/opensign).
gcloud compute firewall-rules create agpl-allow-internal-http \
  --network=scentic-agpl-vpc \
  --action=ALLOW \
  --rules=tcp:80,tcp:8001,tcp:8081,tcp:3101 \
  --source-ranges=10.20.0.0/20,10.30.0.0/28 \
  --direction=INGRESS \
  --project=PROJECT_ID

# Allow Postgres (5432) only from the gateway connector range + subnet.
gcloud compute firewall-rules create agpl-allow-postgres-internal \
  --network=scentic-agpl-vpc \
  --action=ALLOW \
  --rules=tcp:5432 \
  --source-ranges=10.30.0.0/28,10.20.0.0/20 \
  --direction=INGRESS \
  --project=PROJECT_ID

# Deny all other ingress from outside the AGPL VPC (default deny + explicit allow above).
gcloud compute firewall-rules create agpl-deny-all-external \
  --network=scentic-agpl-vpc \
  --action=DENY \
  --rules=all \
  --source-ranges=0.0.0.0/0 \
  --direction=INGRESS \
  --priority=65534 \
  --project=PROJECT_ID
```

SSH to any GCE instance in the AGPL VPC is via **IAP TCP forwarding only** (no public SSH):

```bash
gcloud compute firewall-rules create agpl-allow-iap-ssh \
  --network=scentic-agpl-vpc \
  --action=ALLOW \
  --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 \
  --direction=INGRESS \
  --project=PROJECT_ID
```

## 5. Private Google Access

Private Google Access lets the AGPL VPC reach Google APIs (Secret Manager, Artifact Registry, Cloud SQL admin) without public IPs. It is enabled per-subnet with `--enable-private-ip-google-access` (see §2).

For the **Cloud SQL Postgres** instance used as the gateway durable store, allocate a private IP in the AGPL VPC and disable public IP:

```bash
# Replace PROJECT_ID, REGION, and the allocated range.
# Allocate a range for Cloud SQL private services.
gcloud compute addresses create google-managed-services-agpl \
  --global \
  --purpose=VPC_PEERING \
  --prefix-length=16 \
  --network=scentic-agpl-vpc \
  --project=PROJECT_ID

# Create the private services access connection.
gcloud services vpc-peerings connect \
  --service=servicenetworking.googleapis.com \
  --ranges=google-managed-services-agpl \
  --network=scentic-agpl-vpc \
  --project=PROJECT_ID
```

When creating the Cloud SQL Postgres instance (see `deploy-commands.md`), set `--network=projects/PROJECT_ID/global/networks/scentic-agpl-vpc` and `--no-assign-ip` so the instance has only a private IP reachable from the AGPL VPC and the VPC connector.

## 6. VPC peering with the Scentic core project

The Scentic core project reaches the gateway via VPC peering or an Internal Load Balancer. Peer the two VPCs so the Scentic core can call the gateway's internal URL (`http://gateway.agpl.internal:3101`). See `docs/DEPLOYMENT.md` §4 for the full peering plan.

```bash
# Replace PROJECT_ID (AGPL) and SCENTIC_CORE_PROJECT_ID + SCENTIC_CORE_VPC.
# From the AGPL project:
gcloud compute networks peerings create agpl-to-scentic-core \
  --network=scentic-agpl-vpc \
  --peer-network=SCENTIC_CORE_VPC \
  --peer-project=SCENTIC_CORE_PROJECT_ID \
  --project=PROJECT_ID

# Reciprocal peering from the Scentic core project (run in that project).
# gcloud compute networks peerings create scentic-core-to-agpl \
#   --network=SCENTIC_CORE_VPC \
#   --peer-network=scentic-agpl-vpc \
#   --peer-project=PROJECT_ID \
#   --project=SCENTIC_CORE_PROJECT_ID
```

## 7. What this is NOT

- This is **not** a deployed VPC. No project is provisioned.
- The CIDR ranges above are **examples**. The real deployment must pick non-overlapping ranges.
- The firewall rules are a **baseline**. The real deployment must review them with `security-auditor` before applying.

## 8. Related files

- `deploy/gcloud/cloud-run-gateway.yaml` — references the VPC connector.
- `deploy/gcloud/deploy-commands.md` — Cloud SQL + connector creation commands.
- `docs/DEPLOYMENT.md` §4 — full networking plan (peering, egress, firewall, DNS).
