own=$(sed -n 's/^0:://p' /proc/self/cgroup)
dir=/sys/fs/cgroup${own%/}/$unit

backend_attach() {
  mkdir -p "$dir"
  for p in "$@"; do echo "$p" >"$dir/cgroup.procs" 2>/dev/null || true; done
}

backend_members() {
  cat "$dir/cgroup.procs" 2>/dev/null
}

backend_signal() {
  if [ "$1" = KILL ] && [ -w "$dir/cgroup.kill" ]; then
    echo 1 >"$dir/cgroup.kill"
    return 0
  fi
  for p in $(backend_members); do kill "-$1" "$p" 2>/dev/null || true; done
}

backend_release() {
  rmdir "$dir" 2>/dev/null || true
}
