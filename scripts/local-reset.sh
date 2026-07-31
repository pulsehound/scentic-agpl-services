#!/usr/bin/env bash
# scentic-agpl-services — Destructive reset of local development stack
# LOCAL DEVELOPMENT ONLY — NOT FOR PRODUCTION.
# DESTRUCTIVE: deletes all volumes (databases, files). Irreversible.
set -euo pipefail
echo "WARNING: This will DELETE all local data (databases, files, volumes)."
echo "Press Ctrl+C within 5 seconds to abort..."
sleep 5
echo "Resetting..."
cd "$(dirname "$0")/.."
docker compose -f deploy/docker-compose.yml down -v
echo "All volumes deleted. Run scripts/local-up.sh to start fresh."
