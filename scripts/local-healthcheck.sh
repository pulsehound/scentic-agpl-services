#!/usr/bin/env bash
# scentic-agpl-services — Health check for local development stack
# LOCAL DEVELOPMENT ONLY — NOT FOR PRODUCTION.
set -euo pipefail
echo "Checking scentic-agpl-services local stack health..."
GATEWAY_URL="http://localhost:3101"
KIMAI_URL="http://localhost:8001"
OPENSIGN_URL="http://localhost:8080"
# Gateway health
GW_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/health" 2>/dev/null || echo "000")
echo "Gateway (/health): HTTP $GW_STATUS"
# Gateway status
STATUS_RESP=$(curl -s "$GATEWAY_URL/api/v1/status" 2>/dev/null || echo '{}')
echo "Gateway (/api/v1/status): $STATUS_RESP"
# Kimai
KIMAI_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$KIMAI_URL" 2>/dev/null || echo "000")
echo "Kimai: HTTP $KIMAI_STATUS"
# OpenSign
OS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$OPENSIGN_URL" 2>/dev/null || echo "000")
echo "OpenSign: HTTP $OS_STATUS"
# Source offer
SOURCE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/source" 2>/dev/null || echo "000")
echo "Source offer (/source): HTTP $SOURCE_STATUS"
