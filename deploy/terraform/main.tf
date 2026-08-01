# Infrastructure for the AGPL services.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This lives in the AGPL repository rather than in Scentic's, and deliberately.
# It provisions AGPL-licensed software; keeping it here means the Scentic
# repository contains nothing that describes, configures or deploys AGPL code,
# which is one more place the boundary could otherwise blur.
#
# The services run in the same GCP project and VPC as Scentic. Network adjacency
# is not a licence question — what matters is that they are separate programs,
# separate processes, and talk over HTTP. Sharing a subnet is how Scentic reaches
# the gateway privately, which is a requirement rather than a compromise: the
# gateway carries client documents and time records and must not be reachable
# from the internet.
#
# Three services, three datastores:
#
#   gateway   Cloud Run, internal ingress only. The only thing Scentic talks to.
#   kimai     Cloud Run, internal. Time tracking. Cloud SQL MySQL.
#   opensign  Cloud Run, internal API + public signing pages. MongoDB on a VM.
#
# MongoDB is a VM because GCP has no managed MongoDB and the alternative puts
# signature metadata — who signed what, when — with a third party.

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ---------------------------------------------------------------------------
# Existing network
#
# Scentic's VPC already exists and its Cloud Run services already attach to it.
# Read rather than created: creating a second network would mean the gateway is
# unreachable from Scentic without peering, for no benefit.
# ---------------------------------------------------------------------------

data "google_compute_network" "shared" {
  name = var.network_name
}

data "google_compute_subnetwork" "shared" {
  name   = var.subnet_name
  region = var.region
}

# ---------------------------------------------------------------------------
# Secrets
#
# Generated here rather than typed. Every one of these is a credential that
# would otherwise be invented by a person, written in a terminal, and pasted
# twice.
# ---------------------------------------------------------------------------

# Signs Scentic -> gateway requests.
resource "random_password" "shared_hmac" {
  length  = 48
  special = false
}

# Signs gateway -> Scentic webhooks. Distinct on purpose: one secret for both
# directions would mean anything able to call the gateway could also forge an
# event back into Scentic.
resource "random_password" "webhook_hmac" {
  length  = 48
  special = false
}

resource "random_password" "kimai_db" {
  length  = 32
  special = false
}

resource "random_password" "kimai_app_secret" {
  length  = 40
  special = false
}

resource "random_password" "kimai_admin" {
  length  = 24
  special = false
}

resource "random_password" "gateway_db" {
  length  = 32
  special = false
}

resource "random_password" "opensign_master_key" {
  length  = 40
  special = false
}

resource "random_password" "opensign_admin" {
  length  = 24
  special = false
}

resource "random_password" "mongo_password" {
  length  = 32
  special = false
}

locals {
  secrets = {
    "agpl-shared-hmac-secret"      = random_password.shared_hmac.result
    "agpl-webhook-hmac-secret"     = random_password.webhook_hmac.result
    "agpl-kimai-db-password"       = random_password.kimai_db.result
    "agpl-kimai-app-secret"        = random_password.kimai_app_secret.result
    "agpl-kimai-admin-password"    = random_password.kimai_admin.result
    "agpl-gateway-db-password"     = random_password.gateway_db.result
    "agpl-opensign-master-key"     = random_password.opensign_master_key.result
    "agpl-opensign-admin-password" = random_password.opensign_admin.result
    "agpl-mongo-password"          = random_password.mongo_password.result
  }
}

resource "google_secret_manager_secret" "agpl" {
  for_each  = local.secrets
  secret_id = each.key

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "agpl" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.agpl[each.key].id
  secret_data = each.value
}

# ---------------------------------------------------------------------------
# Runtime identity
# ---------------------------------------------------------------------------

resource "google_service_account" "agpl_runtime" {
  account_id   = "scentic-agpl-runtime"
  display_name = "AGPL services runtime"
  description  = "Runs the gateway, Kimai and OpenSign. Reaches their own databases and secrets, and nothing of Scentic's."
}

resource "google_secret_manager_secret_iam_member" "agpl_runtime" {
  for_each  = google_secret_manager_secret.agpl
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agpl_runtime.email}"
}

resource "google_project_iam_member" "agpl_runtime_sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.agpl_runtime.email}"
}

# The SMTP credential is created by its owner rather than generated here, so it
# is read by name and granted separately.
data "google_secret_manager_secret" "smtp_password" {
  secret_id = var.smtp_password_secret
}

resource "google_secret_manager_secret_iam_member" "agpl_runtime_smtp" {
  secret_id = data.google_secret_manager_secret.smtp_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agpl_runtime.email}"
}

# The signing certificate, when one is configured.
data "google_secret_manager_secret" "signing_cert" {
  for_each  = toset(compact([var.signing_certificate_secret, var.signing_certificate_passphrase_secret]))
  secret_id = each.value
}

resource "google_secret_manager_secret_iam_member" "agpl_runtime_signing_cert" {
  for_each  = data.google_secret_manager_secret.signing_cert
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agpl_runtime.email}"
}

# Scentic's own runtime must read the two HMAC secrets — they are one shared
# value each, held by both sides of the boundary.
resource "google_secret_manager_secret_iam_member" "scentic_runtime_hmac" {
  for_each = toset(["agpl-shared-hmac-secret", "agpl-webhook-hmac-secret"])

  secret_id = google_secret_manager_secret.agpl[each.value].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.scentic_runtime_service_account}"
}
