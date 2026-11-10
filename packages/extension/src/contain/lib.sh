# Shared by every containment backend. A backend defines: backend_attach <pid>..., backend_exists (0 when
# the worker's unit exists, 1 when it does not, another status when that cannot be told), backend_members,
# backend_adopt <pid>..., backend_signal <TERM|KILL>, backend_release. The script is lib.sh, service.sh, one
# backend, then main.sh.
set -u
action=$1 worktree=${2%/}
shift 2
[ -n "$worktree" ] || exit 0
unit=fleet-worker-$(basename "$worktree")-$(printf %s "$worktree" | cksum | cut -d' ' -f1)
host_unit=fleet-host-no-mistakes

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

is_member() {
  case " $(echo $1) " in
    *" $2 "*) return 0 ;;
  esac
  return 1
}

adopt_services() {
  adopted=""
  tries=0
  while :; do
    daemons=$(shared_daemons "$worktree")
    [ -n "$daemons" ] || return 0
    members=$(backend_members) || exit 1
    inside=""
    for p in $(service_tree $daemons); do
      if is_member "$members" "$p"; then inside="$inside $p"; fi
    done
    [ -n "$inside" ] || return 0
    tries=$((tries + 1))
    if [ "$tries" -gt 5 ] || ! backend_adopt $inside; then
      echo "the shared no-mistakes daemon is among the processes of $worktree and could not be moved out, so nothing was stopped:$inside" >&2
      exit 1
    fi
    for p in $daemons; do
      if is_member "$inside" "$p"; then
        adopted="$adopted$p$tab$(ps -o args= -p "$p" 2>/dev/null | cut -c1-100)
"
      fi
    done
  done
}

report_adopted() {
  printf '%s' "$adopted" | while IFS=$tab read -r pid cmd; do
    [ -z "$pid" ] || printf '%s\tADOPTED\t%s\n' "$pid" "$cmd"
  done
}

reap() {
  tab=$(printf '\t')
  adopt_services
  listing=""
  members=$(backend_members) || exit 1
  for p in $members; do
    alive "$p" || continue
    [ "$p" != "$$" ] || continue
    listing="$listing$p$tab$(ps -o args= -p "$p" 2>/dev/null | cut -c1-100)
"
  done
  if [ -z "$listing" ]; then
    report_adopted
    backend_release
    return 0
  fi
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
  report_adopted
  backend_release
}
