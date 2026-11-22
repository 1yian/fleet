#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0 set <ntfy server url> | remove" >&2
  exit 1
fi

NAME=fleet-browser
CONF=/etc/$NAME/config.json
TOPIC_FILE=/etc/$NAME/notify.topic
NODE_BIN=${NODE_BIN:-$(command -v node)}

case "${1:-}" in
  set)
    url=${2:?usage: $0 set <ntfy server url, for example https://ntfy.sh>}
    if [ -t 0 ]; then
      read -rsp "ntfy topic (treat as a password; input hidden): " topic
      echo
    else
      read -r topic
    fi
    [ -n "$topic" ] || { echo "empty topic" >&2; exit 1; }
    (umask 037 && printf '%s\n' "$topic" >"$TOPIC_FILE")
    chown "root:$NAME" "$TOPIC_FILE"
    chmod 640 "$TOPIC_FILE"
    "$NODE_BIN" -e '
      const fs = require("fs");
      const [file, url, topicFile] = process.argv.slice(1);
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.notify = { url, topicFile };
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    ' "$CONF" "$url" "$TOPIC_FILE"
    systemctl restart "$NAME.service"
    echo "handoffs now notify $url"
    ;;
  remove)
    "$NODE_BIN" -e '
      const fs = require("fs");
      const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      delete config.notify;
      fs.writeFileSync(process.argv[1], JSON.stringify(config, null, 2) + "\n");
    ' "$CONF"
    rm -f "$TOPIC_FILE"
    systemctl restart "$NAME.service"
    echo "handoff notifications removed"
    ;;
  *)
    echo "usage: $0 set <ntfy server url> | remove" >&2
    exit 1
    ;;
esac
