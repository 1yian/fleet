#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0 <lane> <item title> <username> <https website>   (password on stdin)" >&2
  exit 1
fi

NAME=fleet-browser
APP_DIR=${APP_DIR:-$(dirname "$(dirname "$(readlink -f "$0")")")}
NODE_BIN=${NODE_BIN:-$(command -v node)}
[ $# -eq 4 ] || { echo "usage: $0 <lane> <item title> <username> <https website>   (password on stdin)" >&2; exit 1; }

CREDENTIALS_DIRECTORY=/etc/$NAME-broker \
FLEET_BROWSER_BROKER_CONFIG=/etc/$NAME-broker/config.json \
  "$NODE_BIN" "$APP_DIR/dist/broker/import.js" "$@"
