#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi

NAME=fleet-browser
APP_DIR=${APP_DIR:-/opt/$NAME}
CONF_DIR=/etc/$NAME
NODE_BIN=${NODE_BIN:-$(command -v node || true)}
[ -x "$NODE_BIN" ] || { echo "set NODE_BIN to an absolute node 24 binary" >&2; exit 1; }
NODE_BIN=$(readlink -f "$NODE_BIN")
CHROME_PATH=${CHROME_PATH:-/opt/google/chrome/chrome}
STREAM_HOST=${FLEET_BROWSER_STREAM_HOST:-$(tailscale ip -4 2>/dev/null | head -n1)}
STREAM_PORT=${FLEET_BROWSER_STREAM_PORT:-7621}
LINK_TEMPLATE=${FLEET_BROWSER_LINK_TEMPLATE:-}

[ -n "$STREAM_HOST" ] || { echo "set FLEET_BROWSER_STREAM_HOST to the address the stream API should bind (the tailnet IPv4)" >&2; exit 1; }
[ -x "$CHROME_PATH" ] || { echo "Chrome not found at $CHROME_PATH" >&2; exit 1; }
CHROME_VERSION=$("$CHROME_PATH" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+')
[ -f "$APP_DIR/dist/daemon/main.js" ] || { echo "build first: $APP_DIR/dist/daemon/main.js is missing" >&2; exit 1; }
for tool in Xvfb xauth nft taskset; do
  command -v "$tool" >/dev/null || { echo "install $tool" >&2; exit 1; }
done

id "$NAME" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/$NAME" --shell /usr/sbin/nologin "$NAME"
id "$NAME-broker" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/$NAME-broker" --shell /usr/sbin/nologin "$NAME-broker"
chmod 700 "/var/lib/$NAME" "/var/lib/$NAME-broker"

if command -v apt-mark >/dev/null && dpkg -s google-chrome-stable >/dev/null 2>&1; then
  apt-mark hold google-chrome-stable >/dev/null
fi

install -d -m 755 "$CONF_DIR"
install -d -m 750 -o root -g "$NAME" "$CONF_DIR/tokens.d"
if ! ls "$CONF_DIR"/tokens.d/*.token >/dev/null 2>&1; then
  (umask 077 && head -c 32 /dev/urandom | xxd -p -c 64 >"$CONF_DIR/tokens.d/default.token")
fi
chown "root:$NAME" "$CONF_DIR"/tokens.d/*.token
chmod 640 "$CONF_DIR"/tokens.d/*.token

if [ ! -f "$CONF_DIR/config.json" ]; then
  link_json=null
  [ -z "$LINK_TEMPLATE" ] || link_json="\"$LINK_TEMPLATE\""
  cat >"$CONF_DIR/config.json" <<JSON
{
  "chrome": { "path": "$CHROME_PATH", "version": "$CHROME_VERSION" },
  "stream": { "host": "$STREAM_HOST", "port": $STREAM_PORT, "tokenDir": "$CONF_DIR/tokens.d" },
  "handoff": { "linkTemplate": $link_json },
  "lanes": { "totalCpus": $(nproc) }
}
JSON
fi
chmod 644 "$CONF_DIR/config.json"
install -m 644 "$APP_DIR/deploy/$NAME.nft" "$CONF_DIR/$NAME.nft"
sed -e "s|@NODE_BIN@|$NODE_BIN|" -e "s|@APP_DIR@|$APP_DIR|" "$APP_DIR/deploy/$NAME.service" >"/etc/systemd/system/$NAME.service"
systemctl daemon-reload
systemctl enable "$NAME.service" >/dev/null
systemctl restart "$NAME.service"

echo "$NAME installed: chrome $CHROME_VERSION, stream api on $STREAM_HOST:$STREAM_PORT, tokens in $CONF_DIR/tokens.d"
