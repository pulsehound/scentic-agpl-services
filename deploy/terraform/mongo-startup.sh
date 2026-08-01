#!/bin/bash
# MongoDB for OpenSign.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Runs once on first boot. Binds to the VM's internal address only — there is no
# public IP on this instance and no reason for Mongo to listen anywhere else.
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

curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc \
  | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
echo "deb [signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" \
  > /etc/apt/sources.list.d/mongodb-org-7.0.list

apt-get update -y
apt-get install -y mongodb-org

PASSWORD="$(gcloud secrets versions access latest \
  --secret='${secret_name}' --project='${project_id}')"

# Start without auth to create the user, then lock it down. The window is a few
# seconds on a host with no public address, inside a firewall that only admits
# this subnet.
systemctl start mongod
sleep 8

mongosh --quiet --eval "
  db.getSiblingDB('admin').createUser({
    user: 'opensign',
    pwd: '$PASSWORD',
    roles: [{ role: 'readWrite', db: 'opensign' }, { role: 'dbAdmin', db: 'opensign' }]
  });
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

touch /var/lib/scentic-mongo-initialised
