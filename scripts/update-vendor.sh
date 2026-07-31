#!/bin/bash
# Update upstream vendor repos

set -e

echo "=== Updating vendor repos ==="

if [ -d vendor/kimai ]; then
  echo "Updating Kimai..."
  cd vendor/kimai
  git pull --depth 1
  cd ../..
  echo "Kimai updated."
else
  echo "WARNING: vendor/kimai not found. Run scripts/setup.sh first."
fi

if [ -d vendor/opensign ]; then
  echo "Updating OpenSign..."
  cd vendor/opensign
  git pull --depth 1
  cd ../..
  echo "OpenSign updated."
else
  echo "WARNING: vendor/opensign not found. Run scripts/setup.sh first."
fi

echo "=== Update complete ==="
