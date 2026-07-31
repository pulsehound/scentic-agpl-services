#!/usr/bin/env bash
# scentic-agpl-services — Destructive reset of local development stack
# LOCAL DEVELOPMENT ONLY — NOT FOR PRODUCTION.
# DESTRUCTIVE: deletes all volumes (databases, files, volumes). Irreversible.
set -euo pipefail
echo "============================================================"
echo "  WARNING: DESTRUCTIVE RESET"
echo "============================================================"
echo ""
echo "This will DELETE all local data:"
echo "  - Gateway Postgres database (gateway-pg-data)"
echo "  - Kimai MariaDB database (kimai-db-data)"
echo "  - OpenSign MongoDB database (opensign-mongo-data)"
echo "  - Gateway logs (gateway-logs)"
echo ""
echo "This action is IRREVERSIBLE."
echo ""
echo "Press Ctrl+C within 10 seconds to abort..."
echo "============================================================"
sleep 10
echo ""
echo "Resetting..."
cd "$(dirname "$0")/.."
docker compose -f deploy/docker-compose.yml down -v
echo "All volumes deleted. Run scripts/local-up.sh to start fresh."
