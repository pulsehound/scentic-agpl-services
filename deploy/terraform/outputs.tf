# SPDX-License-Identifier: AGPL-3.0-or-later
#
# What Scentic needs in order to be pointed at this stack.
#
# The secrets are not output. They live in Secret Manager and Scentic's runtime
# reads them from there; printing them here would put every credential into
# terraform.tfstate in plaintext and into any terminal that ran an apply.

output "gateway_url" {
  description = "Set as SCENTIC_AGPL_GATEWAY_URL. Internal ingress: reachable from Scentic's Cloud Run and nowhere else."
  # Empty until the second apply — see the count on the gateway service.
  value       = one(google_cloud_run_v2_service.gateway[*].uri)
}

output "opensign_public_url" {
  description = "Where signers land from the emailed link. Public by necessity — a counterparty has no Scentic account."
  value       = google_cloud_run_v2_service.opensign.uri
}

output "kimai_url" {
  description = "Internal only. Reached through the gateway, never directly."
  value       = google_cloud_run_v2_service.kimai.uri
}

output "mongo_internal_ip" {
  description = "MongoDB, reachable only from inside the VPC. No public address exists."
  value       = google_compute_address.mongo.address
}

output "secret_names" {
  description = "Secret Manager entries holding the generated credentials."
  value       = { for k, v in google_secret_manager_secret.agpl : k => v.secret_id }
}

output "scentic_env" {
  description = <<-EOT
    The three variables that switch Scentic on, with the secrets referenced
    rather than inlined.

    Apply with:
      gcloud run services update scentic-staging-web --region=us-east1 \
        --update-secrets=SCENTIC_AGPL_GATEWAY_HMAC_SECRET=agpl-shared-hmac-secret:latest,SCENTIC_AGPL_WEBHOOK_HMAC_SECRET=agpl-webhook-hmac-secret:latest \
        --set-env-vars=SCENTIC_AGPL_GATEWAY_URL=<gateway_url>,SCENTIC_AGPL_TIME_TRACKING_ENABLED=true,SIGNATURE_PROVIDER_TYPE=AGPL_GATEWAY
  EOT
  value = {
    SCENTIC_AGPL_GATEWAY_URL           = one(google_cloud_run_v2_service.gateway[*].uri)
    SCENTIC_AGPL_TIME_TRACKING_ENABLED = "true"
    SIGNATURE_PROVIDER_TYPE            = "AGPL_GATEWAY"
  }
}
