#!/usr/bin/env bash
set -euo pipefail

readonly ATTEMPTS=4
readonly DNS_TIMEOUT_SECONDS=15
readonly MIRROR_LIST=/etc/apt/apt-mirrors.txt
readonly FALLBACK_MIRRORS=(
  https://mirror.us.leaseweb.net/ubuntu/
  https://ftp.osuosl.org/pub/ubuntu/
  https://mirrors.xtom.com/ubuntu/
)

RETRY_ATTEMPT=1
PACKAGES=()

error() { echo "::error title=install-chromium::$*"; }
warning() { echo "::warning title=install-chromium::$*"; }

retry() {
  local what=$1 delay=10
  shift
  for RETRY_ATTEMPT in $(seq "$ATTEMPTS"); do
    if "$@"; then return 0; fi
    if ((RETRY_ATTEMPT < ATTEMPTS)); then
      echo "${what} failed (attempt ${RETRY_ATTEMPT} of ${ATTEMPTS}), retrying in ${delay}s"
      sleep "$delay"
      delay=$((delay * 3))
    fi
  done
  return 1
}

archive_host() {
  [[ -r $MIRROR_LIST ]] || return 0
  sed -n 's|^https\?://\([^/]*\)/.*|\1|p' "$MIRROR_LIST" | head -n 1
}

archive_resolves() {
  local host
  host=$(archive_host)
  [[ -z $host ]] || timeout "$DNS_TIMEOUT_SECONDS" getent hosts "$host" >/dev/null
}

use_fallback_mirrors_when_archive_is_unreachable() {
  if archive_resolves; then return 0; fi
  warning "$(archive_host) does not resolve from this runner, so apt uses mirrors outside ubuntu.com"
  local priority=1 mirror
  for mirror in "${FALLBACK_MIRRORS[@]}"; do
    printf '%s\tpriority:%d\n' "$mirror" "$priority"
    priority=$((priority + 1))
  done | sudo tee "$MIRROR_LIST" >/dev/null
}

install_packages() {
  use_fallback_mirrors_when_archive_is_unreachable
  local options=(-o Acquire::Retries=2 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=120)
  if ((RETRY_ATTEMPT > 1)); then
    sudo apt-get update -q "${options[@]}" || true
  fi
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${options[@]}" "${PACKAGES[@]}"
}

retry "Chromium download" npx playwright install chromium || {
  error "Chromium could not be downloaded after ${ATTEMPTS} attempts. Playwright's download hosts were unreachable from this runner."
  exit 1
}

status=0
report=$(npx playwright install-deps --dry-run chromium 2>&1) || status=$?
echo "$report"
if ((status == 0)); then
  echo "Every system package for Chromium is installed, so apt is not needed."
  exit 0
fi

mapfile -t PACKAGES < <(sed -n 's/^  \([a-z0-9][a-z0-9.+:-]*\)$/\1/p' <<<"$report")
if ((${#PACKAGES[@]} == 0)); then
  error "Playwright could not list the system packages that Chromium lacks (output above)."
  exit 1
fi

retry "apt install of ${PACKAGES[*]}" install_packages || {
  resolves=yes
  archive_resolves || resolves=no
  error "apt could not install ${PACKAGES[*]} after ${ATTEMPTS} attempts. The first apt mirror, $(archive_host), resolves: ${resolves}. This is the runner's network or the package mirrors, not a test failure."
  exit 1
}

npx playwright install-deps --dry-run chromium || {
  error "Chromium still lacks system packages after apt installed them (output above)."
  exit 1
}
