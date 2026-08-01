# Datastores for the AGPL services.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Three, because the three services genuinely need different things and sharing
# one would couple their upgrade cycles: Kimai is MySQL-only, the gateway's
# outbox wants Postgres row locking, and OpenSign is built on MongoDB.
#
# None of them is Scentic's database. Scentic keeps its own instance and its own
# data, and nothing here can reach it.
#
# Sized for staging. db-f1-micro is not a production shape and is chosen
# knowingly: this is the tier the rest of the deployment is in, and RB-010 still
# forbids real client data anywhere.

# ---------------------------------------------------------------------------
# Kimai — MySQL
# ---------------------------------------------------------------------------

resource "google_sql_database_instance" "kimai" {
  name             = "scentic-agpl-kimai"
  database_version = "MYSQL_8_0"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_size         = 10
    disk_autoresize   = true

    ip_configuration {
      # Private only. A time tracker holds which firm worked how long on which
      # client, which is confidential even without a document attached.
      ipv4_enabled                                  = false
      private_network                               = data.google_compute_network.shared.id
      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled            = true
      binary_log_enabled = true
      start_time         = "03:00"
    }

    database_flags {
      # Kimai's schema needs this for its longer indexes.
      name  = "innodb_large_prefix"
      value = "on"
    }
  }

  # Staging, and deliberately destroyable — this whole stack is meant to be
  # rebuildable from this configuration.
  deletion_protection = false
}

resource "google_sql_database" "kimai" {
  name      = "kimai"
  instance  = google_sql_database_instance.kimai.name
  charset   = "utf8mb4"
  collation = "utf8mb4_unicode_ci"
}

resource "google_sql_user" "kimai" {
  name     = "kimai"
  instance = google_sql_database_instance.kimai.name
  password = random_password.kimai_db.result
}

# ---------------------------------------------------------------------------
# Gateway — Postgres
#
# Postgres specifically: the webhook outbox claims events with
# SELECT ... FOR UPDATE SKIP LOCKED so several gateway instances can drain it
# without delivering the same event twice. MySQL's equivalent is weaker and the
# gateway's store is written against Postgres.
# ---------------------------------------------------------------------------

resource "google_sql_database_instance" "gateway" {
  name             = "scentic-agpl-gateway"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_size         = 10
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = data.google_compute_network.shared.id
      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:30"
      point_in_time_recovery_enabled = true
    }
  }

  deletion_protection = false
}

resource "google_sql_database" "gateway" {
  name     = "gateway"
  instance = google_sql_database_instance.gateway.name
}

resource "google_sql_user" "gateway" {
  name     = "gateway"
  instance = google_sql_database_instance.gateway.name
  password = random_password.gateway_db.result
}

# ---------------------------------------------------------------------------
# OpenSign — MongoDB on a VM
#
# GCP has no managed MongoDB. The alternative is a hosted provider, which would
# put signature metadata — who signed what, and when — outside this project and
# under somebody else's terms. For a legal product that is a data-processing
# relationship worth avoiding, so it runs here.
#
# No external address. Reachable only from inside the VPC.
# ---------------------------------------------------------------------------

resource "google_compute_address" "mongo" {
  name         = "scentic-agpl-mongo"
  subnetwork   = data.google_compute_subnetwork.shared.id
  address_type = "INTERNAL"
  region       = var.region
}

resource "google_compute_instance" "mongo" {
  name         = "scentic-agpl-mongo"
  machine_type = var.mongo_machine_type
  zone         = var.zone

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    network    = data.google_compute_network.shared.id
    subnetwork = data.google_compute_subnetwork.shared.id
    network_ip = google_compute_address.mongo.address
    # No access_config block: the VM gets no public IP at all.
  }

  service_account {
    email  = google_service_account.agpl_runtime.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    # Password read from Secret Manager on boot rather than baked into metadata,
    # which is readable by anything that can describe the instance.
    startup-script = templatefile("${path.module}/mongo-startup.sh", {
      project_id     = var.project_id
      secret_name    = google_secret_manager_secret.agpl["agpl-mongo-password"].secret_id
      bind_address   = google_compute_address.mongo.address
    })
  }

  tags = ["agpl-mongo"]

  # The startup script installs MongoDB; replacing the VM re-runs it against an
  # empty disk, which would lose the data. Changes to the script are applied by
  # rebuilding deliberately, not by a plan nobody read.
  lifecycle {
    ignore_changes = [metadata]
  }
}

# Only the AGPL services reach Mongo, and only on its own port.
resource "google_compute_firewall" "mongo" {
  name    = "scentic-agpl-mongo-in"
  network = data.google_compute_network.shared.name

  allow {
    protocol = "tcp"
    ports    = ["27017"]
  }

  # The subnet range rather than the whole VPC: Cloud Run reaches Mongo through
  # direct VPC egress from this subnet, and nothing outside it has any business
  # connecting.
  source_ranges = [data.google_compute_subnetwork.shared.ip_cidr_range]
  target_tags   = ["agpl-mongo"]
}
