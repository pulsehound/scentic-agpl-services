# The three Cloud Run services.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Ingress is the thing to read carefully here. Two of the three are internal
# only — nothing outside the VPC can reach them at all. OpenSign is the
# exception and has to be, because the people signing are usually not Scentic
# users: they are the other side of a transaction, following a link from an
# email, with no account and no VPN.
#
# That asymmetry is the security boundary of this whole integration, so it is
# stated rather than left to be inferred from an annotation.

locals {
  # Direct VPC egress rather than a Serverless VPC Access connector: it is
  # cheaper, has no throughput ceiling to size, and is the supported path now.
  vpc_access = {
    network    = data.google_compute_network.shared.name
    subnetwork = data.google_compute_subnetwork.shared.name
  }
}

# ---------------------------------------------------------------------------
# Kimai — time tracking
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "kimai" {
  name     = "scentic-agpl-kimai"
  location = var.region
  # Internal only. Time data is reached through the gateway, never directly, and
  # nobody signs in to Kimai from the internet.
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  deletion_protection = false

  template {
    service_account = google_service_account.agpl_runtime.email

    scaling {
      # One instance minimum: Kimai is a PHP application with a slow cold start,
      # and the gateway's calls would otherwise time out on the first request
      # after a quiet period.
      min_instance_count = 1
      max_instance_count = 2
    }

    vpc_access {
      network_interfaces {
        network    = local.vpc_access.network
        subnetwork = local.vpc_access.subnetwork
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.kimai_image

      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }

      env {
        name  = "DATABASE_URL"
        value = "mysql://kimai:${random_password.kimai_db.result}@${google_sql_database_instance.kimai.private_ip_address}:3306/kimai?charset=utf8mb4&serverVersion=8.0.0"
      }
      env {
        name  = "APP_ENV"
        value = "prod"
      }
      env {
        name  = "APP_SECRET"
        value = random_password.kimai_app_secret.result
      }
      env {
        name  = "ADMINMAIL"
        value = var.admin_email
      }
      env {
        name  = "ADMINPASS"
        value = random_password.kimai_admin.result
      }
      env {
        name  = "TRUSTED_PROXIES"
        value = "0.0.0.0/0"
      }

      ports {
        container_port = 8001
      }

      startup_probe {
        # Kimai runs migrations on first boot, which takes a while on a micro
        # instance. A short probe would kill it mid-migration and leave a half
        # created schema.
        initial_delay_seconds = 30
        timeout_seconds       = 10
        period_seconds        = 15
        failure_threshold     = 20
        tcp_socket { port = 8001 }
      }
    }
  }

  depends_on = [google_sql_database.kimai, google_sql_user.kimai]
}

# ---------------------------------------------------------------------------
# OpenSign — e-signature
#
# The one public service, and only because it must be. A signer is typically a
# counterparty with no Scentic account; they receive a link by email and open it
# from wherever they are.
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "opensign" {
  name     = "scentic-agpl-opensign"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account = google_service_account.agpl_runtime.email

    scaling {
      min_instance_count = 1
      max_instance_count = 3
    }

    vpc_access {
      network_interfaces {
        network    = local.vpc_access.network
        subnetwork = local.vpc_access.subnetwork
      }
      # Private ranges only: it reaches Mongo inside the VPC and sends mail out
      # through the mail provider, which resolves publicly. If mail needs egress
      # this becomes ALL_TRAFFIC with a NAT — noted rather than guessed.
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.opensign_image

      resources {
        limits = { cpu = "1", memory = "2Gi" }
      }

      env {
        name  = "MONGODB_URI"
        value = "mongodb://opensign:${random_password.mongo_password.result}@${google_compute_address.mongo.address}:27017/opensign?authSource=admin"
      }
      env {
        name  = "APP_ID"
        value = var.opensign_app_id
      }
      env {
        name  = "MASTER_KEY"
        value = random_password.opensign_master_key.result
      }
      env {
        name  = "PARSE_MOUNT"
        value = "/app"
      }
      env {
        name  = "SERVER_URL"
        value = "https://scentic-agpl-opensign-${var.project_number}.${var.region}.run.app/app"
      }
      env {
        name  = "PUBLIC_URL"
        value = "https://scentic-agpl-opensign-${var.project_number}.${var.region}.run.app"
      }
      env {
        name  = "SMTP_ENABLE"
        value = "true"
      }
      env {
        name  = "SMTP_HOST"
        value = var.smtp_host
      }
      env {
        name  = "SMTP_PORT"
        value = tostring(var.smtp_port)
      }
      env {
        name  = "SMTP_USER_EMAIL"
        value = var.smtp_user
      }
      env {
        name  = "SMTP_PASS"
        value = var.smtp_password
      }

      ports {
        container_port = 8080
      }

      startup_probe {
        initial_delay_seconds = 20
        timeout_seconds       = 10
        period_seconds        = 15
        failure_threshold     = 20
        tcp_socket { port = 8080 }
      }
    }
  }

  depends_on = [google_compute_instance.mongo]
}

# The signing pages must be openable by anyone holding the emailed link.
resource "google_cloud_run_v2_service_iam_member" "opensign_public" {
  name     = google_cloud_run_v2_service.opensign.name
  location = google_cloud_run_v2_service.opensign.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------------------
# The gateway — the only thing Scentic talks to
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "gateway" {
  # Created only once Kimai's API token exists.
  #
  # The gateway validates its configuration at startup and refuses to run
  # without that token — correctly, since a gateway that starts and cannot reach
  # the time tracker is a service that accepts work and drops it. But the token
  # is issued by Kimai's own UI after Kimai is running, so it cannot exist on the
  # first apply.
  #
  # Rather than leave a crash-looping service behind and call it provisioned,
  # the dependency is made explicit: apply once to build everything else, obtain
  # the token, then apply again. See README.md.
  count = var.kimai_api_token == "" ? 0 : 1

  name     = "scentic-agpl-gateway"
  location = var.region
  # Internal only, always. It carries client documents on their way to be
  # signed and the firm's time records. Nothing outside the VPC needs it, and
  # HMAC is a second lock rather than the only one.
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  deletion_protection = false

  template {
    service_account = google_service_account.agpl_runtime.email

    scaling {
      min_instance_count = 1
      max_instance_count = 3
    }

    vpc_access {
      network_interfaces {
        network    = local.vpc_access.network
        subnetwork = local.vpc_access.subnetwork
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = var.gateway_image

      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "GATEWAY_PORT"
        value = "8080"
      }
      env {
        name  = "GATEWAY_STORE_TYPE"
        value = "postgres"
      }
      env {
        name  = "GATEWAY_DATABASE_URL"
        value = "postgresql://gateway:${random_password.gateway_db.result}@${google_sql_database_instance.gateway.private_ip_address}:5432/gateway"
      }
      env {
        name  = "GATEWAY_POSTGRES_SSL_MODE"
        value = "disable"
      }
      env {
        name  = "SCENTIC_SHARED_HMAC_SECRET"
        value = random_password.shared_hmac.result
      }
      env {
        name  = "SCENTIC_WEBHOOK_HMAC_SECRET"
        value = random_password.webhook_hmac.result
      }
      env {
        name  = "SCENTIC_WEBHOOK_TARGET_URL"
        value = "${var.scentic_base_url}/api/agpl/webhooks"
      }
      env {
        name  = "KIMAI_BASE_URL"
        value = google_cloud_run_v2_service.kimai.uri
      }
      env {
        name  = "KIMAI_ADMIN_USERNAME"
        value = var.admin_email
      }
      env {
        name  = "KIMAI_ADMIN_API_TOKEN"
        value = var.kimai_api_token
      }
      env {
        name  = "KIMAI_DEFAULT_ACTIVITY_NAME"
        value = "Legal work"
      }
      env {
        # Descriptions are not sent to the tracker. A time entry's note can name
        # a client matter, and the tracker is a reporting system rather than a
        # confidential one.
        name  = "KIMAI_USE_CONFIDENTIAL_LABELS"
        value = "false"
      }
      env {
        name  = "OPENSIGN_ENABLED"
        value = "true"
      }
      env {
        name  = "OPENSIGN_BASE_URL"
        value = google_cloud_run_v2_service.opensign.uri
      }
      env {
        name  = "OPENSIGN_APP_ID"
        value = var.opensign_app_id
      }
      env {
        name  = "OPENSIGN_MASTER_KEY"
        value = random_password.opensign_master_key.result
      }
      env {
        name  = "SCENTIC_GATEWAY_PUBLIC_BASE_URL"
        value = var.scentic_base_url
      }
      env {
        # Its own address. Cloud Run URLs are deterministic from the service
        # name and project number, so this is known before the service exists —
        # which is the only way to hand a service its own URL in one apply.
        name  = "SCENTIC_GATEWAY_INTERNAL_BASE_URL"
        value = "https://scentic-agpl-gateway-${var.project_number}.${var.region}.run.app"
      }

      ports {
        container_port = 8080
      }

      startup_probe {
        initial_delay_seconds = 10
        timeout_seconds       = 5
        period_seconds        = 10
        failure_threshold     = 12
        http_get {
          path = "/health"
          port = 8080
        }
      }
    }
  }

  depends_on = [
    google_sql_database.gateway,
    google_sql_user.gateway,
    google_cloud_run_v2_service.kimai,
    google_cloud_run_v2_service.opensign,
  ]
}

# Scentic's runtime is the only identity permitted to call the gateway.
resource "google_cloud_run_v2_service_iam_member" "gateway_caller" {
  count = var.kimai_api_token == "" ? 0 : 1

  name     = google_cloud_run_v2_service.gateway[0].name
  location = google_cloud_run_v2_service.gateway[0].location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.scentic_runtime_service_account}"
}
