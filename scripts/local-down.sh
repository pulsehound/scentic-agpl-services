#!/usr/bin/env bash
# scentic-agpl-services — Stop local development stack
# LOCAL DEVELOPMENT ONLY — NOT FOR PRODUCTION.
set -euo pipefail
echo "Stopping scentic-agpl-services local stack..."
cd "$(dirname "$0")/.."
docker compose -f deploy/docker-compose.yml down
echo "Local stack stopped. Volumes preserved."
echo "To reset all data, run scripts/local-reset.sh (DESTRUCTIVE)."
