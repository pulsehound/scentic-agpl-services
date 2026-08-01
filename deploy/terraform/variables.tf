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

variable "kimai_api_token_secret" {
  description = <<-EOT
    Secret Manager entry holding the Kimai API token, by name — never the token.

    Cannot be provisioned: Kimai issues it from its own interface after the
    instance is up and an administrator has signed in once. So the first apply
    leaves this empty and the gateway is not created; the second sets it and the
    gateway comes up. The dependency is real and is made explicit rather than
    worked around.

    Referenced rather than passed as a value, for the same reason as the SMTP
    password: a sensitive variable still lands in terraform.tfstate in plaintext.
  EOT
  type        = string
  default     = ""
}

variable "smtp_host" {
  description = "Mail host OpenSign sends signature invitations through. Without it, signers are never told there is anything to sign."
  type        = string
  default     = "smtp.resend.com"
}

variable "smtp_port" {
  type    = number
  default = 587
}

variable "smtp_user" {
  description = "SMTP username. MailerSend generates one per verified domain; it is not the account login."
  type        = string
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
      printf '%s' '<smtp password>' | gcloud secrets create agpl-smtp-password         --replication-policy=automatic --data-file=-
  EOT
  type        = string
  default     = "agpl-smtp-password"
}

variable "kimai_open_for_setup" {
  description = <<-EOT
    Temporarily expose Kimai so an administrator can create the API token.

    Kimai issues its token from its own web interface and nowhere else, and the
    service is otherwise unreachable from outside the VPC — so there is a
    genuine chicken and egg here, and this is the least bad way through it.

    Declared rather than done by hand with gcloud: an out-of-band ingress change
    would be silently reverted by the next apply, which is worse than a variable
    that says what it is. Set it true, create the token, set it false again.

    The exposure is a login page with a long generated password, for as long as
    it takes to copy a token. It is still exposure, and it should not be left on.
  EOT
  type        = bool
  default     = false
}

variable "signing_certificate_secret" {
  description = <<-EOT
    Secret Manager entry holding the PKCS#12 signing certificate, base64
    encoded, or "" to run without one.

    This is what makes a completed PDF cryptographically signed rather than
    merely recorded as signed. Without it OpenSign still captures who signed,
    when, and from where — the audit trail is intact — but the document itself
    carries no signature a reader can verify.

    The certificate identifies the *service* that applied the signature, not the
    individual signer. Signer identity lives in the audit trail. Which level of
    certificate a jurisdiction requires is a legal question, not a technical one.
  EOT
  type        = string
  default     = ""
}

variable "signing_certificate_passphrase_secret" {
  description = "Secret Manager entry holding the certificate's passphrase."
  type        = string
  default     = ""
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
