# Outbound internet for services that have no public address.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Everything in this stack is deliberately unreachable from the internet, and
# on the first apply that turned out to mean unable to reach it either. Three
# things broke at once, all for the same reason:
#
#   the MongoDB VM has no external address, so `apt-get install mongodb-org`
#   could not resolve deb.debian.org and MongoDB was never installed;
#
#   OpenSign could not reach the mail provider, so signature invitations would
#   have been composed and never sent;
#
#   the gateway could not reach app.scentic.com, so every webhook back to
#   Scentic would have failed and a signed document would never have updated
#   its workflow.
#
# Cloud NAT is the answer to all three. It is outbound only: nothing on the
# internet can open a connection inward through it, so the ingress rules remain
# the security boundary and nothing is loosened by having it.
#
# The alternative — giving the VM a public IP — would have fixed the install and
# put a database on the internet to do it.

resource "google_compute_router" "agpl" {
  name    = "scentic-agpl-router"
  region  = var.region
  network = data.google_compute_network.shared.id
}

resource "google_compute_router_nat" "agpl" {
  name   = "scentic-agpl-nat"
  router = google_compute_router.agpl.name
  region = var.region

  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    # Errors only. Logging every translation on a NAT that exists to fetch
    # packages and send mail is a bill rather than an audit trail.
    enable = true
    filter = "ERRORS_ONLY"
  }
}
