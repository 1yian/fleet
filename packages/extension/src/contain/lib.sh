# Shared by every containment backend. A backend defines: backend_attach <pid>..., backend_members,
# backend_signal <TERM|KILL>, backend_release. The script is lib.sh, one backend, then main.sh.
set -u
action=$1 worktree=${2%/}
shift 2
[ -n "$worktree" ] || exit 0
unit=fleet-worker-$(basename "$worktree")-$(printf %s "$worktree" | cksum | cut -d' ' -f1)

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

alive() {
  case $(ps -o stat= -p "$1" 2>/dev/null) in
    "" | Z*) return 1 ;;
  esac
  return 0
}

drained() {
  members=$(backend_members) || exit 1
  for p in $members; do
    if alive "$p"; then return 1; fi
  done
  return 0
}

wait_drained() {
  tries=0
  while [ "$tries" -lt "$1" ]; do
    drained && return 0
    sleep 0.2
    tries=$((tries + 1))
  done
  return 1
}

reap() {
  tab=$(printf '\t')
  listing=""
  members=$(backend_members) || exit 1
  for p in $members; do
    alive "$p" || continue
    [ "$p" != "$$" ] || continue
    listing="$listing$p$tab$(ps -o args= -p "$p" 2>/dev/null | cut -c1-100)
"
  done
  [ -n "$listing" ] || { backend_release; return 0; }
  how=TERM
  backend_signal TERM
  if ! wait_drained 25; then
    how=KILL
    backend_signal KILL
    wait_drained 10 || how=ALIVE
  fi
  printf '%s' "$listing" | while IFS=$tab read -r pid cmd; do
    if alive "$pid"; then
      printf '%s\tALIVE\t%s\n' "$pid" "$cmd"
    else
      printf '%s\t%s\t%s\n' "$pid" "$how" "$cmd"
    fi
  done
  backend_release
}
