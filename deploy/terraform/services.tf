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

# Credentials are referenced, never inlined.
#
# An `env { value = ... }` holding a password is readable by anyone with
# run.services.get — roles/viewer is enough — and appears in `gcloud run
# services describe`, in the Console, and in deployment logs. A secret_key_ref
# is resolved by the runtime at start-up instead, so reading it needs
# secretmanager.versions.access, which is a separate grant with its own audit
# trail.
#
# This file originally inlined ten of them, including both HMAC secrets — the
# entire authentication boundary between Scentic and this stack, in a field a
# project viewer could read. The three connection strings are stored whole
# rather than as a password assembled into a URI here, since assembling it in
# Terraform puts the finished credential back into the service configuration.
#
# Terraform state still holds these values in plaintext; that is inherent to
# random_password and is why the state bucket is access-controlled separately.

resource "google_cloud_run_v2_service" "kimai" {
  name     = "scentic-agpl-kimai"
  location = var.region
  # Internal only. Time data is reached through the gateway, never directly, and
  # nobody signs in to Kimai from the internet — except once, to create the API
  # token the gateway needs, which Kimai only issues from its own interface.
  ingress = var.kimai_open_for_setup ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"

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
      # Through Cloud NAT. Kimai fetches nothing itself, but a Symfony
      # application that cannot resolve anything behaves oddly in ways that are
      # tedious to attribute, and the NAT is already there.
      egress = "ALL_TRAFFIC"
    }

    containers {
      image = var.kimai_image

      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-kimai-database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "APP_ENV"
        value = "prod"
      }
      env {
        name = "APP_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-kimai-app-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "ADMINMAIL"
        value = var.admin_email
      }
      env {
        name = "ADMINPASS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-kimai-admin-password"].secret_id
            version = "latest"
          }
        }
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
# OpenSign — two services, not one
#
# The upstream project ships a Parse backend and a React frontend as separate
# images, and both are required. This stack ran only the frontend, so there was
# no Parse API at all: every gateway call to /classes/... was answered with the
# frontend's index.html, and a POST with 405. The gateway reported that as
# "createTenant failed", which reads as OpenSign rejecting the tenant rather
# than as no OpenSign API existing.
#
# It also put the SMTP settings on the frontend, where nothing sends mail.
#
# Both are public. The backend is not an internal service that only the gateway
# calls: the signing pages run in a counterparty's browser and talk to it
# directly, so making it internal would break the very flow it exists for. The
# protection is Parse's own app-id/master-key model, not the network.
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "opensign_server" {
  name     = "scentic-agpl-opensign-server"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account = google_service_account.agpl_runtime.email

    scaling {
      # Scale to zero when idle.
      #
      # Holding one instance warm bills for a whole vCPU and its memory every
      # second of the month whether a request arrives or not. Across the four
      # services here that was roughly $213 of a $282 monthly bill — spent
      # waiting for traffic that, on a staging deployment used by a handful of
      # people, mostly does not come.
      #
      # The cost of zero is a cold start on the first request after an idle
      # period: a few seconds for the gateway, longer for the OpenSign backend,
      # which is a 1.4 GB image. That is paid by whoever sends a document for
      # signature after a quiet afternoon, and it is worth it here.
      #
      # A production deployment with people waiting on it should reconsider
      # this. The number is small and the reasoning is not universal.
      min_instance_count = 0
      max_instance_count = 3
    }

    vpc_access {
      network_interfaces {
        network    = local.vpc_access.network
        subnetwork = local.vpc_access.subnetwork
      }
      # Mongo is inside the VPC; the mail provider is not.
      egress = "ALL_TRAFFIC"
    }

    containers {
      image = var.opensign_server_image

      resources {
        limits = { cpu = "1", memory = "2Gi" }
      }

      env {
        name = "MONGODB_URI"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-mongo-uri"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "APP_ID"
        value = var.opensign_app_id
      }
      env {
        name = "MASTER_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-opensign-master-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "PARSE_MOUNT"
        value = "/app"
      }
      # Parse builds absolute links — including the ones emailed to signers —
      # from this, so it must be the address a counterparty can actually reach,
      # and must carry the mount path.
      env {
        name  = "SERVER_URL"
        value = "https://scentic-agpl-opensign-server-${var.project_number}.${var.region}.run.app/app"
      }
      env {
        name  = "USE_LOCAL"
        value = "TRUE"
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
      # The two names are the wrong way round from what they look like, and
      # OpenSign reads them literally:
      #
      #   SMTP_USERNAME    the account used to authenticate. Auth is only
      #                    attached when this AND SMTP_PASS are both present,
      #                    so leaving it unset does not fall back to anything —
      #                    it sends with no credentials at all.
      #
      #   SMTP_USER_EMAIL  the address mail is sent *from*, despite the name
      #                    reading like a login.
      #
      # SMTP_USER_NAME, which is what was set before, is read nowhere in the
      # application. Between them these meant unauthenticated mail sent from an
      # address of "resend".
      env {
        name  = "SMTP_USERNAME"
        value = var.smtp_user
      }
      env {
        name = "SMTP_PASS"
        value_source {
          secret_key_ref {
            secret  = var.smtp_password_secret
            version = "latest"
          }
        }
      }
      env {
        name  = "SMTP_USER_EMAIL"
        value = var.smtp_from_address
      }

      # The signing certificate, when there is one. Conditional so the stack
      # runs without it: signatures are still recorded and the audit trail is
      # intact, the PDF simply carries no verifiable signature.
      dynamic "env" {
        for_each = var.signing_certificate_secret == "" ? [] : [1]
        content {
          name = "PFX_BASE64"
          value_source {
            secret_key_ref {
              secret  = var.signing_certificate_secret
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = var.signing_certificate_passphrase_secret == "" ? [] : [1]
        content {
          name = "PASS_PHRASE"
          value_source {
            secret_key_ref {
              secret  = var.signing_certificate_passphrase_secret
              version = "latest"
            }
          }
        }
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

  depends_on = [google_compute_instance.mongo, google_compute_router_nat.agpl]
}

# The signing pages a counterparty opens. Serves static assets and calls the
# backend from the browser, which is why it needs the backend's public address
# rather than an internal one.
resource "google_cloud_run_v2_service" "opensign" {
  name     = "scentic-agpl-opensign"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account = google_service_account.agpl_runtime.email

    scaling {
      # Scale to zero when idle.
      #
      # Holding one instance warm bills for a whole vCPU and its memory every
      # second of the month whether a request arrives or not. Across the four
      # services here that was roughly $213 of a $282 monthly bill — spent
      # waiting for traffic that, on a staging deployment used by a handful of
      # people, mostly does not come.
      #
      # The cost of zero is a cold start on the first request after an idle
      # period: a few seconds for the gateway, longer for the OpenSign backend,
      # which is a 1.4 GB image. That is paid by whoever sends a document for
      # signature after a quiet afternoon, and it is worth it here.
      #
      # A production deployment with people waiting on it should reconsider
      # this. The number is small and the reasoning is not universal.
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.opensign_image

      resources {
        limits = { cpu = "1", memory = "1Gi" }
      }

      env {
        name  = "REACT_APP_SERVERURL"
        value = "${google_cloud_run_v2_service.opensign_server.uri}/app"
      }
      env {
        name  = "REACT_APP_APPID"
        value = var.opensign_app_id
      }

      ports {
        container_port = 3000
      }

      startup_probe {
        initial_delay_seconds = 15
        timeout_seconds       = 10
        period_seconds        = 15
        failure_threshold     = 20
        tcp_socket { port = 3000 }
      }
    }
  }
}

# Only while the setup window is open, and removed the moment it closes.
resource "google_cloud_run_v2_service_iam_member" "kimai_setup_access" {
  count = var.kimai_open_for_setup ? 1 : 0

  name     = google_cloud_run_v2_service.kimai.name
  location = google_cloud_run_v2_service.kimai.location
  role     = "roles/run.invoker"
  member   = "allUsers"
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
  count = var.kimai_api_token_secret == "" ? 0 : 1

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
      # Scale to zero when idle.
      #
      # Holding one instance warm bills for a whole vCPU and its memory every
      # second of the month whether a request arrives or not. Across the four
      # services here that was roughly $213 of a $282 monthly bill — spent
      # waiting for traffic that, on a staging deployment used by a handful of
      # people, mostly does not come.
      #
      # The cost of zero is a cold start on the first request after an idle
      # period: a few seconds for the gateway, longer for the OpenSign backend,
      # which is a 1.4 GB image. That is paid by whoever sends a document for
      # signature after a quiet afternoon, and it is worth it here.
      #
      # A production deployment with people waiting on it should reconsider
      # this. The number is small and the reasoning is not universal.
      min_instance_count = 0
      max_instance_count = 3
    }

    vpc_access {
      network_interfaces {
        network    = local.vpc_access.network
        subnetwork = local.vpc_access.subnetwork
      }
      # The gateway posts webhooks to app.scentic.com, which is public. Without
      # this a signed document would never update its workflow in Scentic, and
      # the failure would look like a signing problem rather than a routing one.
      egress = "ALL_TRAFFIC"
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
        name = "GATEWAY_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-gateway-database-url"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "GATEWAY_POSTGRES_SSL_MODE"
        value = "disable"
      }
      env {
        name = "SCENTIC_SHARED_HMAC_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-shared-hmac-secret"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SCENTIC_WEBHOOK_HMAC_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-webhook-hmac-secret"].secret_id
            version = "latest"
          }
        }
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
        name = "KIMAI_ADMIN_API_TOKEN"
        value_source {
          secret_key_ref {
            secret  = var.kimai_api_token_secret
            version = "latest"
          }
        }
      }
      env {
        # Kimai 2.30 answers a Bearer request 401 and the same token in X-AUTH
        # headers 200. Tested against the deployed instance before anything was
        # wired to depend on it.
        name  = "KIMAI_AUTH_MODE"
        value = "legacy"
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
        name = "OPENSIGN_BASE_URL"
        # The backend, and with /app: Parse is mounted there, so a base URL
        # without it addresses the frontend's catch-all route instead of the API.
        value = "${google_cloud_run_v2_service.opensign_server.uri}/app"
      }
      env {
        name  = "OPENSIGN_APP_ID"
        value = var.opensign_app_id
      }
      # Where a signer opens the document: the frontend, not the API. Signing
      # links go to counterparties with no account and no VPN, so this is the
      # one OpenSign address that has to be publicly reachable — and pointing it
      # at the API base produces links that resolve to JSON.
      env {
        name  = "OPENSIGN_PUBLIC_URL"
        value = google_cloud_run_v2_service.opensign.uri
      }
      env {
        name = "OPENSIGN_MASTER_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-opensign-master-key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "OPENSIGN_ADMIN_EMAIL"
        value = var.admin_email
      }
      env {
        name = "OPENSIGN_ADMIN_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.agpl["agpl-opensign-admin-password"].secret_id
            version = "latest"
          }
        }
      }
      env {
        # See isPrivateUrl in the gateway's config. Every Cloud Run service has
        # a public hostname regardless of who may reach it, so the private-URL
        # check cannot pass here. This asserts what the ingress settings in this
        # file already enforce: the gateway and Kimai are internal-only.
        #
        # OpenSign is the exception and is genuinely public, because signers are
        # counterparties without accounts. The gateway reaches it over TLS with
        # the master key.
        name  = "GATEWAY_ALLOW_CLOUD_RUN_INTERNAL"
        value = "true"
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
  count = var.kimai_api_token_secret == "" ? 0 : 1

  name     = google_cloud_run_v2_service.gateway[0].name
  location = google_cloud_run_v2_service.gateway[0].location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.scentic_runtime_service_account}"
}

# The signing backend is reached by counterparties' browsers, not only by the
# gateway, so it cannot sit behind an IAM check the way Kimai does. Parse's
# app-id and master-key model is the control here.
resource "google_cloud_run_v2_service_iam_member" "opensign_server_public" {
  name     = google_cloud_run_v2_service.opensign_server.name
  location = google_cloud_run_v2_service.opensign_server.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# The gateway is the only identity permitted to call Kimai.
#
# Missing until now, and Kimai's IAM policy was empty as a result: *nobody* could
# invoke it. Cloud Run refused every request with 403 before Kimai saw it, the
# gateway's Kimai client reported that as "auth failed", and firm initialisation
# came back 502 — which reads like Kimai being broken rather than never having
# been called.
#
# Internal ingress and IAM are not the same control and neither implies the
# other. Ingress says which networks may reach the service; this says which
# identity may invoke it. Kimai had the first and not the second.
resource "google_cloud_run_v2_service_iam_member" "kimai_caller" {
  name     = google_cloud_run_v2_service.kimai.name
  location = google_cloud_run_v2_service.kimai.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.agpl_runtime.email}"
}
