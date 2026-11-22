#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0 add <client> [--copy-to <path> --owner <user>] | revoke <client>" >&2
  exit 1
fi

NAME=fleet-browser
DIR=/etc/$NAME/tokens.d
action=${1:-}
client=${2:-}
[[ "$client" =~ ^[a-z0-9-]+$ ]] || { echo "client must be lowercase letters, digits and hyphens" >&2; exit 1; }

case "$action" in
  add)
    shift 2
    copy_to=""
    owner=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --copy-to) copy_to=$2; shift 2 ;;
        --owner) owner=$2; shift 2 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
      esac
    done
    token=$(head -c 32 /dev/urandom | xxd -p -c 64)
    (umask 077 && printf '%s\n' "$token" >"$DIR/$client.token")
    chown "root:$NAME" "$DIR/$client.token"
    chmod 640 "$DIR/$client.token"
    if [ -n "$copy_to" ]; then
      [ -n "$owner" ] || { echo "--copy-to needs --owner" >&2; exit 1; }
      install -d -m 700 -o "$owner" "$(dirname "$copy_to")"
      (umask 077 && printf '%s\n' "$token" >"$copy_to")
      chown "$owner" "$copy_to"
      chmod 600 "$copy_to"
      echo "token for $client written to $copy_to (mode 600, owner $owner); the daemon accepts it within 2 seconds"
    else
      echo "token for $client stored in $DIR/$client.token; read it with sudo, never paste it into a chat or a log"
    fi
    ;;
  revoke)
    rm -f "$DIR/$client.token"
    echo "token for $client revoked"
    ;;
  *)
    echo "usage: $0 add <client> [--copy-to <path> --owner <user>] | revoke <client>" >&2
    exit 1
    ;;
esac
