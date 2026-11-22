#!/bin/sh
set -eu
herdr_bin=${HERDR_BIN_PATH:-herdr}
summary=$(fleet-browser lanes --plain | head -n 8)
exec "$herdr_bin" notification show "Browser lanes" --body "$summary"
