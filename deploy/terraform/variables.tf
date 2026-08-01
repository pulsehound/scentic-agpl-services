# SPDX-License-Identifier: AGPL-3.0-or-later

variable "project_id" {
  description = "GCP project. The AGPL services share Scentic's project and VPC — adjacency is not a licence question, and it is how Scentic reaches the gateway privately."
  type        = string
  default     = "causal-hour-502018-c8"
}

variable "project_number" {
  description = "Numeric project id, used to construct Cloud Run URLs before the services exist."
  type        = string
  default     = "707955469035"
}

variable "region" {
  description = "Same region as Scentic, so the private hop between them stays in one region."
  type        = string
  default     = "us-east1"
}

variable "zone" {
  description = "Zone for the MongoDB instance."
  type        = string
  default     = "us-east1-b"
}

variable "network_name" {
  description = "Existing VPC, created by Scentic's own Terraform. Read here, never modified."
  type        = string
  default     = "scentic-staging"
}

variable "subnet_name" {
  type    = string
  default = "scentic-staging-us-east1"
}

variable "scentic_runtime_service_account" {
  description = "Scentic's Cloud Run identity. The only caller permitted to reach the gateway, and the only outside reader of the two shared HMAC secrets."
  type        = string
}

variable "scentic_base_url" {
  description = "Where the gateway posts webhooks back to."
  type        = string
  default     = "https://app.scentic.com"
}

variable "db_tier" {
  description = <<-EOT
    Cloud SQL machine type.

    db-f1-micro is a staging shape and is chosen knowingly: this whole stack
    matches the tier the rest of the deployment is in, and RB-010 forbids real
    client data anywhere until the restore drill passes.
  EOT
  type        = string
  default     = "db-f1-micro"
}

variable "mongo_machine_type" {
  description = "MongoDB VM. e2-small is enough for signature metadata, which is small and written rarely."
  type        = string
  default     = "e2-small"
}

variable "admin_email" {
  description = "Administrator account created inside Kimai and OpenSign."
  type        = string
}

variable "gateway_image" {
  description = "Gateway image in Artifact Registry."
  type        = string
}

variable "kimai_image" {
  description = "Kimai image. Upstream publishes one; it is pinned rather than tracking latest so a redeploy is not an upgrade."
  type        = string
  default     = "kimai/kimai2:apache-2.30.0"
}

variable "opensign_image" {
  description = "OpenSign image, pinned for the same reason."
  type        = string
  default     = "opensign/opensign:main"
}

variable "opensign_app_id" {
  description = "Parse application id. Not a secret on its own, but paired with the master key."
  type        = string
  default     = "scentic-opensign"
}

variable "kimai_api_token" {
  description = <<-EOT
    API token for the Kimai administrator.

    Cannot be provisioned: Kimai issues it from its own UI after the instance is
    up and the admin has signed in once. Left empty on the first apply and set on
    the second — see README.md. Stated rather than pretended around.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

variable "smtp_host" {
  description = "Mail host OpenSign sends signature invitations through. Without it, signers are never told there is anything to sign."
  type        = string
}

variable "smtp_port" {
  type    = number
  default = 587
}

variable "smtp_user" {
  type = string
}

variable "smtp_password_secret" {
  description = <<-EOT
    Secret Manager entry holding the SMTP password, by name — never the password
    itself.

    A `sensitive` variable still lands in terraform.tfstate in plaintext, still
    passes through whoever runs the apply, and would have had to be sent to
    somebody to get here. Referencing it means the credential is created once, by
    its owner, and read only by the service that sends the mail.

    Create it with:
      printf '%s' '<api-key>' | gcloud secrets create agpl-smtp-password         --replication-policy=automatic --data-file=-
  EOT
  type        = string
  default     = "agpl-smtp-password"
}

variable "smtp_from_address" {
  description = <<-EOT
    The address signature invitations come from.

    Client-facing: the recipient is usually a counterparty, not a Scentic user.
    It should be on a domain with SPF and DKIM set up for the sending provider,
    or the invitations arrive in spam and the signing never happens.
  EOT
  type        = string
}
