scope=$unit.scope

bus() {
  XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
  export XDG_RUNTIME_DIR
}
bus

cgroup_dir() {
  if ! state=$(systemctl --user show -p LoadState --value "$scope" 2>/dev/null); then
    state=$(systemctl --user is-active "$scope" 2>/dev/null)
    [ "$state" = inactive ] && return 1
    return 2
  fi
  [ "$state" != not-found ] || return 1
  path=$(systemctl --user show -p ControlGroup --value "$scope" 2>/dev/null) || return 2
  [ -n "$path" ] && [ -d "/sys/fs/cgroup$path" ] || return 1
  printf '/sys/fs/cgroup%s' "$path"
}

start_scope() {
  set -- $roots
  busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \
    org.freedesktop.systemd1.Manager StartTransientUnit "ssa(sv)a(sa(sv))" \
    "$scope" fail 3 PIDs au "$#" "$@" Description s "fleet ${scope%.scope}" Delegate b true 0 >/dev/null
}

attach_pid() {
  err=$(busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \
    org.freedesktop.systemd1.Manager AttachProcessesToUnit ssau "$scope" "" 1 "$1" 2>&1 >/dev/null) && return 0
  alive "$1" || return 0
  echo "$err" >&2
  return 1
}

await_cgroup() {
  tries=0
  until cgroup_dir >/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 50 ] || { echo "$scope has no cgroup after 5 seconds" >&2; return 1; }
    sleep 0.1
  done
}

backend_attach() {
  cgroup_dir >/dev/null || { start_scope && await_cgroup || return 1; }
  for p in "$@"; do
    attach_pid "$p" || return 1
  done
}

backend_adopt() {
  (
    scope=$host_unit.scope
    roots=$1
    systemctl --user reset-failed "$scope" 2>/dev/null || true
    backend_attach "$@"
  )
}

backend_members() {
  dir=$(cgroup_dir)
  case $? in
    0) cat "$dir/cgroup.procs" ;;
    1) return 0 ;;
    *) return 1 ;;
  esac
}

backend_signal() {
  systemctl --user kill --kill-whom=all --signal="$1" "$scope" 2>/dev/null || true
}

backend_release() {
  systemctl --user reset-failed "$scope" 2>/dev/null || true
}
