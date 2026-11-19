#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi

NAME=fleet-browser
systemctl disable --now "$NAME.service" 2>/dev/null || true
rm -f "/etc/systemd/system/$NAME.service"
systemctl daemon-reload
nft delete table inet fleet_browser 2>/dev/null || true
rm -rf "/etc/$NAME" "/run/$NAME"
if [ "${PURGE_DATA:-0}" = 1 ]; then
  userdel -r "$NAME" 2>/dev/null || true
  userdel -r "$NAME-broker" 2>/dev/null || true
fi
echo "$NAME uninstalled; browser profiles and vault state kept unless PURGE_DATA=1"
