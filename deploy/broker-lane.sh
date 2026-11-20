#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0 show | lane <lane> | allow <lane> <Personal item title> | deny <lane> <Personal item title>" >&2
  exit 1
fi

NAME=fleet-browser
CONF=/etc/$NAME-broker/config.json
NODE_BIN=${NODE_BIN:-$(command -v node)}
action=${1:-}

edit() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, action, lane, title] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.lanes = config.lanes || {};
    if (action === "show") {
      for (const [name, titles] of Object.entries(config.lanes)) console.log(name + ": " + (titles.length ? titles.join(" | ") : "(nothing copied from Personal)"));
      process.exit(0);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(lane || "")) { console.error("lane must be lowercase letters, digits and hyphens"); process.exit(1); }
    if (action === "lane") config.lanes[lane] = config.lanes[lane] || [];
    else if (action === "allow") {
      if (!title) { console.error("give the exact Personal item title"); process.exit(1); }
      const list = config.lanes[lane] || [];
      if (!list.includes(title)) list.push(title);
      config.lanes[lane] = list;
    } else if (action === "deny") {
      config.lanes[lane] = (config.lanes[lane] || []).filter((t) => t !== title);
    }
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  ' "$CONF" "$@"
}

case "$action" in
  show) edit show ;;
  lane|allow|deny)
    edit "$@"
    chown "root:$NAME-broker" "$CONF"
    chmod 640 "$CONF"
    systemctl restart "$NAME-broker.service"
    echo "done; broker restarted and the lane vault synced"
    ;;
  *)
    echo "usage: $0 show | lane <lane> | allow <lane> <Personal item title> | deny <lane> <Personal item title>" >&2
    exit 1
    ;;
esac
