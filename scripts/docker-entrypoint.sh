#!/bin/sh
set -eu

# Existing Railway volumes may contain files created by the old root process.
# Prepare only the data volume as root, then drop privileges for the server.
if [ "$(id -u)" = 0 ]; then
  data_dir="${DATA_DIR:-/app/data}"
  mkdir -p "$data_dir"
  chown -R node:node "$data_dir"
  chmod 700 "$data_dir"
  exec gosu node "$@"
fi
exec "$@"
