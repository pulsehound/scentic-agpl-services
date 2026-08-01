#!/bin/bash
# MongoDB for OpenSign.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Runs on every boot and exits immediately once it has succeeded once. Binds to
# the VM's internal address only — there is no public IP on this instance and no
# reason for Mongo to listen anywhere else.
#
# The password comes from Secret Manager at boot rather than from instance
# metadata, which is readable by anything that can describe the instance.
set -euo pipefail

if [ -f /var/lib/scentic-mongo-initialised ]; then
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y gnupg curl

# --batch --yes, and both are needed. Without them gpg tries to open /dev/tty to
# ask about overwriting the keyring, and a startup script has no controlling
# terminal — it fails with "cannot open '/dev/tty'", which reads like a
# permissions problem and is not one. The overwrite question arises at all
# because a previous failed run may have left the file behind.
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg

echo "deb [signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" \
  > /etc/apt/sources.list.d/mongodb-org-7.0.list

apt-get update -y
apt-get install -y mongodb-org

PASSWORD="$(gcloud secrets versions access latest \
  --secret='${secret_name}' --project='${project_id}')"

# Start without auth to create the user, then lock it down. The window is a few
# seconds on a host with no public address, inside a firewall that admits only
# this subnet.
systemctl start mongod

# Waited for rather than slept past: a fixed sleep is a guess that is either
# wasteful or wrong, and the failure mode is a createUser against a socket that
# is not listening yet.
for i in $(seq 1 60); do
  if mongosh --quiet --eval 'db.adminCommand({ ping: 1 })' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Idempotent: a re-run after a partial failure must not abort because the user
# is already there.
mongosh --quiet --eval "
  const admin = db.getSiblingDB('admin');
  const existing = admin.getUser('opensign');
  if (existing === null) {
    admin.createUser({
      user: 'opensign',
      pwd: '$PASSWORD',
      roles: [{ role: 'readWrite', db: 'opensign' }, { role: 'dbAdmin', db: 'opensign' }]
    });
  } else {
    admin.changeUserPassword('opensign', '$PASSWORD');
  }
"

cat > /etc/mongod.conf <<CONF
storage:
  dbPath: /var/lib/mongodb
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
net:
  port: 27017
  # The VM's own address, never 0.0.0.0. Combined with having no public IP this
  # means Mongo is reachable from inside the VPC and nowhere else.
  bindIp: 127.0.0.1,${bind_address}
security:
  authorization: enabled
CONF

systemctl restart mongod
systemctl enable mongod

# Only after everything above has succeeded. `set -e` means a failure anywhere
# skips this, so the next boot retries rather than declaring victory.
touch /var/lib/scentic-mongo-initialised
