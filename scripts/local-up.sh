#!/usr/bin/env bash
# scentic-agpl-services — Start local development stack
# LOCAL DEVELOPMENT ONLY — NOT FOR PRODUCTION.
set -euo pipefail
echo "Starting scentic-agpl-services local stack..."
cd "$(dirname "$0")/.."
# Check for .env file
if [ ! -f .env ]; then
  echo "WARNING: .env file not found. Copy .env.example to .env and configure."
  echo "Continuing with defaults..."
fi
docker compose -f deploy/docker-compose.yml up -d
echo ""
echo "Waiting for services to start..."
sleep 15
# Health checks
echo "Gateway health: $(curl -s http://localhost:3101/health || echo 'not ready')"
echo "Gateway status: $(curl -s http://localhost:3101/api/v1/status || echo 'not ready')"
echo "Mock Scentic: $(curl -s http://localhost:3199/health || echo 'not ready')"
echo "Gateway Postgres: http://localhost:5433"
echo "Kimai: http://localhost:8001"
echo "OpenSign: http://localhost:8080"
echo "OpenSign UI: http://localhost:3000"
echo "MailHog: http://localhost:8025"
echo ""
echo "Local stack started. Run scripts/local-healthcheck.sh to verify."
echo "Mock Scentic events: curl http://localhost:3199/events"
