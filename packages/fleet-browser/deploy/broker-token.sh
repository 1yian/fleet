#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0 set | remove" >&2
  exit 1
fi

NAME=fleet-browser
FILE=/etc/$NAME-broker/op-token

case "${1:-}" in
  set)
    if [ -t 0 ]; then
      read -rsp "1Password service account token for the broker (input hidden): " token
      echo
    else
      read -r token
    fi
    [ -n "$token" ] || { echo "empty token" >&2; exit 1; }
    install -d -m 755 -o root -g root "/etc/$NAME-broker"
    (umask 077 && printf '%s\n' "$token" >"$FILE")
    chown root:root "$FILE"
    chmod 600 "$FILE"
    systemctl restart "$NAME-broker.service"
    echo "broker token stored (root only); broker restarted and lane vaults synced"
    ;;
  remove)
    systemctl stop "$NAME-broker.service" || true
    rm -f "$FILE"
    echo "broker token removed; broker stopped"
    ;;
  *)
    echo "usage: $0 set | remove" >&2
    exit 1
    ;;
esac
