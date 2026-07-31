#!/bin/bash
# scentic-agpl-services setup script
# Run after cloning the repo for the first time

set -e

echo "=== scentic-agpl-services setup ==="

# Check prerequisites
echo "Checking prerequisites..."
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "WARNING: docker not found (needed for local dev)"; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required"; exit 1; }

# Copy env example
if [ ! -f .env ]; then
  echo "Copying .env.example to .env..."
  cp .env.example .env
  echo "WARNING: Edit .env with real values before running."
else
  echo ".env already exists, skipping copy."
fi

# Check vendor repos
if [ ! -d vendor/kimai ]; then
  echo "Cloning Kimai..."
  git clone --depth 1 https://github.com/kimai/kimai.git vendor/kimai
else
  echo "Kimai already present."
fi

if [ ! -d vendor/opensign ]; then
  echo "Cloning OpenSign..."
  git clone --depth 1 https://github.com/OpenSignLabs/OpenSign.git vendor/opensign
else
  echo "OpenSign already present."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "1. Edit .env with real values"
echo "2. Read docs/SCENTIC_AGPL_INTEGRATION_PLAN.md"
echo "3. Read docs/SCENTIC_AGPL_CONNECTION_MANUAL.md"
echo "4. For local dev: cd deploy && docker compose up -d"
echo ""
echo "AGPL-00 status: DISCOVERY / ARCHITECTURE / WORKSPACE SETUP COMPLETE"
