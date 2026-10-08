# HTTP/2 (cleartext) in front of a service that only speaks HTTP/1.1.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Cloud Run refuses any HTTP/1 request over 32 MiB before the container sees it — which put a
# ceiling of roughly 24 MB on a document sent for signature (the bytes travel base64 in JSON), and
# the same ceiling on the signed PDF a signer's browser posts back. With the service set to use
# HTTP/2 end to end there is no such limit; neither the gateway (Express 4) nor OpenSign's Parse
# server speaks h2c, so this sidecar does, and passes each request on over HTTP/1.1 on localhost.
#
# Bodies stream through unbuffered and unbounded here; the application behind decides how large is
# too large.
FROM nginx:1.27.3-alpine
COPY default.conf.template /etc/nginx/templates/default.conf.template
ENV UPSTREAM_PORT=8081
