#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0 set | remove" >&2
  exit 1
fi

NAME=fleet-browser
FILE=/etc/$NAME/openai.key

case "${1:-}" in
  set)
    if [ -t 0 ]; then
      read -rsp "OpenAI API key for the captcha solver (input hidden): " key
      echo
    else
      read -r key
    fi
    [ -n "$key" ] || { echo "empty key" >&2; exit 1; }
    (umask 037 && printf '%s\n' "$key" >"$FILE")
    chown "root:$NAME" "$FILE"
    chmod 640 "$FILE"
    systemctl restart "$NAME.service"
    echo "captcha solver key stored"
    ;;
  remove)
    rm -f "$FILE"
    echo "captcha solver key removed"
    ;;
  *)
    echo "usage: $0 set | remove" >&2
    exit 1
    ;;
esac
