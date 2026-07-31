#!/usr/bin/env bash
# scentic-agpl-services — Health check for local development stack
# LOCAL DEVELOPMENT ONLY — NOT FOR PRODUCTION.
set -euo pipefail
echo "Checking scentic-agpl-services local stack health..."
GATEWAY_URL="http://localhost:3101"
KIMAI_URL="http://localhost:8001"
OPENSIGN_URL="http://localhost:8080"
MOCK_SCENTIC_URL="http://localhost:3199"
POSTGRES_URL="localhost:5433"

# Gateway health
GW_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/health" 2>/dev/null || echo "000")
echo "Gateway (/health): HTTP $GW_STATUS"

# Gateway status (includes store type)
STATUS_RESP=$(curl -s "$GATEWAY_URL/api/v1/status" 2>/dev/null || echo '{}')
echo "Gateway (/api/v1/status): $STATUS_RESP"

# Mock Scentic webhook receiver
MS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$MOCK_SCENTIC_URL/health" 2>/dev/null || echo "000")
echo "Mock Scentic (/health): HTTP $MS_STATUS"

# Gateway Postgres (check via docker)
PG_STATUS=$(docker compose -f deploy/docker-compose.yml ps gateway-postgres --format "{{.Status}}" 2>/dev/null || echo "not found")
echo "Gateway Postgres: $PG_STATUS"

# Kimai
KIMAI_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$KIMAI_URL" 2>/dev/null || echo "000")
echo "Kimai: HTTP $KIMAI_STATUS"

# OpenSign
OS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$OPENSIGN_URL" 2>/dev/null || echo "000")
echo "OpenSign: HTTP $OS_STATUS"

# Source offer
SOURCE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/source" 2>/dev/null || echo "000")
echo "Source offer (/source): HTTP $SOURCE_STATUS"

# Mock Scentic events
if [ "$MS_STATUS" = "200" ]; then
  EVENTS_COUNT=$(curl -s "$MOCK_SCENTIC_URL/events" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('events',[])))" 2>/dev/null || echo "?")
  echo "Mock Scentic events received: $EVENTS_COUNT"
fi

echo ""
echo "Health check complete."
