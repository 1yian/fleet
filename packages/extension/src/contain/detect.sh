# Prints the containment backend this host supports: systemd, cgroup, or sweep.
# Chosen from what the host can do, never from its name.
XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export XDG_RUNTIME_DIR
if [ "$(uname -s)" = Linux ] && [ -d /sys/fs/cgroup ]; then
  if command -v busctl >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 &&
    systemctl --user show-environment >/dev/null 2>&1 &&
    [ -d "/sys/fs/cgroup/user.slice/user-$(id -u).slice" ]; then
    echo systemd
    exit 0
  fi
  own=$(sed -n 's/^0:://p' /proc/self/cgroup)
  probe=/sys/fs/cgroup${own%/}/fleet-probe-$$
  if mkdir "$probe" 2>/dev/null; then
    rmdir "$probe"
    echo cgroup
    exit 0
  fi
fi
echo sweep
