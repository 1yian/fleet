# Finds the host-shared services that a worker started and that must outlive it. Shared by every
# containment backend and by stop-procs.sh, so that close, stop, and restart spare the same processes.
# A host-shared service is a no-mistakes daemon that its own root vouches for: the process runs
# "<path>/no-mistakes daemon run --root <root>", the root is a folder of this user outside the worktree,
# and <root>/daemon.pid names this very process. The executable and the root of a daemon that lives
# inside the worktree belong to the worker, so that daemon is not shared and stops with it.

descendants() {
  ps -axo pid=,ppid= | awk -v roots="$*" '
    BEGIN { n = split(roots, r, " "); for (i = 1; i <= n; i++) keep[r[i]] = 1 }
    { id[NR] = $1; parent[$1] = $2 }
    END {
      do {
        grew = 0
        for (i in id) if (!(id[i] in keep) && (parent[id[i]] in keep)) { keep[id[i]] = 1; grew = 1 }
      } while (grew)
      for (k in keep) print k
    }'
}

recorded_pid() {
  sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1/daemon.pid" 2>/dev/null | head -n 1
}

shared_daemons() {
  tab=$(printf '\t')
  ps -axo pid=,args= | awk -v tree="${1%/}" '
    function inside(path) { return path == tree || index(path, tree "/") == 1 }
    {
      pid = $1
      line = $0
      sub(/^ *[0-9]+ +/, "", line)
      marker = " daemon run --root "
      at = index(line, marker)
      if (at == 0) next
      exe = substr(line, 1, at - 1)
      root = substr(line, at + length(marker))
      if (exe !~ /(^|\/)no-mistakes$/ || root !~ /^\// || inside(exe) || inside(root)) next
      print pid "\t" root
    }' | while IFS=$tab read -r pid root; do
    [ -d "$root" ] && [ -O "$root" ] || continue
    [ "$(recorded_pid "$root")" = "$pid" ] || continue
    printf '%s\n' "$pid"
  done
}

service_tree() {
  [ "$#" -gt 0 ] || return 0
  printf '%s\n' "$@"
  descendants "$@" | while read -r pid; do
    case " $* " in
      *" $pid "*) ;;
      *) printf '%s\n' "$pid" ;;
    esac
  done
}
