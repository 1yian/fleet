scope=$unit.scope

bus() {
  XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
  export XDG_RUNTIME_DIR
}
bus

cgroup_dir() {
  if ! path=$(systemctl --user show -p ControlGroup --value "$scope" 2>/dev/null); then
    systemctl --user show-environment >/dev/null 2>&1 || return 2
    return 1
  fi
  [ -n "$path" ] && [ -d "/sys/fs/cgroup$path" ] || return 1
  printf '/sys/fs/cgroup%s' "$path"
}

backend_attach() {
  if dir=$(cgroup_dir); then
    for p in "$@"; do
      echo "$p" >"$dir/cgroup.procs" 2>/dev/null || ! alive "$p" || return 1
    done
    return 0
  fi
  list=$#
  busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 \
    org.freedesktop.systemd1.Manager StartTransientUnit "ssa(sv)a(sa(sv))" \
    "$scope" fail 2 PIDs au "$list" "$@" Description s "fleet worker $unit" 0 >/dev/null
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
