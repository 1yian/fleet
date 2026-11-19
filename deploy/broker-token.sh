#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0 set <lane> | remove <lane>" >&2
  exit 1
fi

NAME=fleet-browser
DIR=/etc/$NAME-broker/tokens
action=${1:-}
lane=${2:-}
[[ "$lane" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { echo "lane must be lowercase letters, digits and hyphens" >&2; exit 1; }

case "$action" in
  set)
    if [ -t 0 ]; then
      read -rsp "1Password service account token for lane $lane (input hidden): " token
      echo
    else
      read -r token
    fi
    [ -n "$token" ] || { echo "empty token" >&2; exit 1; }
    install -d -m 750 -o "$NAME-broker" -g "$NAME-broker" "$DIR"
    (umask 077 && printf '%s\n' "$token" >"$DIR/$lane.token")
    chown "$NAME-broker:$NAME-broker" "$DIR/$lane.token"
    chmod 600 "$DIR/$lane.token"
    echo "token for lane $lane stored; vault expected: $NAME-$lane"
    ;;
  remove)
    rm -f "$DIR/$lane.token"
    echo "token for lane $lane removed"
    ;;
  *)
    echo "usage: $0 set <lane> | remove <lane>" >&2
    exit 1
    ;;
esac
