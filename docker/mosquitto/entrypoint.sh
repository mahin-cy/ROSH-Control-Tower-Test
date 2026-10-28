#!/bin/sh
# Generates /mosquitto/runtime/passwd fresh on every container start from
# MOSQUITTO_BACKEND_USERNAME/MOSQUITTO_BACKEND_PASSWORD (docker/.env,
# gitignored, never baked into the image). Always overwrites rather than
# only-if-missing: rotation must work by just changing the env var +
# recreating the container, not by remembering to also wipe a volume.
#
# acl.conf is also copied here (from a read-only source bind mount) rather
# than referenced directly at its bind-mounted path: on a Windows host,
# bind-mounted files don't carry meaningful Unix ownership/permission
# bits, which trips Mosquitto's own ownership/permission checks on
# acl_file (a warning today, a hard failure in future Mosquitto versions).
# Copying it into the writable named volume and chowning/chmod-ing it here
# gives it real, correct Unix permissions regardless of the host OS.
set -eu

: "${MOSQUITTO_BACKEND_USERNAME:?MOSQUITTO_BACKEND_USERNAME must be set}"
: "${MOSQUITTO_BACKEND_PASSWORD:?MOSQUITTO_BACKEND_PASSWORD must be set}"

mkdir -p /mosquitto/runtime

# -c alone doesn't reliably overwrite an existing file left by a prior
# (e.g. failed) run — remove it first so every start is a clean slate.
rm -f /mosquitto/runtime/passwd
mosquitto_passwd -c -b /mosquitto/runtime/passwd \
  "$MOSQUITTO_BACKEND_USERNAME" "$MOSQUITTO_BACKEND_PASSWORD"

cp /mosquitto/acl-src/acl.conf /mosquitto/runtime/acl.conf

# mosquitto drops privileges to the "mosquitto" user by default (confirmed
# empirically — it does this even with no `user` directive set in
# mosquitto.conf), but this script runs as root, so files it just
# wrote/copied are unreadable by that user, and acl_file specifically
# requires 0700 + mosquitto ownership (see comment above).
chown -R mosquitto:mosquitto /mosquitto/runtime
chmod 0700 /mosquitto/runtime/acl.conf

exec mosquitto -c /mosquitto/config/mosquitto.conf
