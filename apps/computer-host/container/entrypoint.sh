#!/bin/sh
set -eu

# Egress interception terminates TLS, so this process has to trust the CA the
# platform mints for it. The certificate is ephemeral — minted per container
# start and mounted here — so it is trusted at start rather than baked into the
# image.
#
# `NODE_EXTRA_CA_CERTS` rather than the system trust store: Node's own TLS is
# the only one this process uses (the Sprites SDK's fetch and the exec
# WebSocket both go through it), and it needs no root, which the system store
# would, because the container runs as `node`.
CLOUDFLARE_CONTAINERS_CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt
if [ -f "$CLOUDFLARE_CONTAINERS_CA" ]; then
  NODE_EXTRA_CA_CERTS="$CLOUDFLARE_CONTAINERS_CA"
  export NODE_EXTRA_CA_CERTS
fi

exec npm start
