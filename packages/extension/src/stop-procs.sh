# Stops every process that lives inside one worktree: its cwd is the worktree or below,
# or its command line names a path inside it. Whole path components only, so c-71-a1
# never matches c-71-a10. Never touches this script, its ancestors, or its children. Sends TERM, waits
# up to 5 seconds, then KILL for what remains. Prints one line per process:
# <pid> <TAB> TERM|KILL|ALIVE <TAB> <command>.
# Usage: sh -c "$(cat stop-procs.sh)" stop <worktree>
set -u
root=${1%/}
[ -n "$root" ] || exit 0

snapshot() {
  {
    if [ -d /proc/self ]; then
      for d in /proc/[0-9]*; do
        c=$(readlink "$d/cwd" 2>/dev/null) || continue
        printf 'C %s %s\n' "${d#/proc/}" "$c"
      done
    else
      lsof -a -d cwd -Fpn 2>/dev/null | awk '
        /^p/ { pid = substr($0, 2) }
        /^n/ { print "C", pid, substr($0, 2) }'
    fi
    ps -axo pid=,ppid=,stat=,args= | sed 's/^ */P /'
  } | ROOT=$root SELF=$$ awk '
    BEGIN { ROOT = ENVIRON["ROOT"]; SELF = ENVIRON["SELF"] }
    function pathchar(c) { return c ~ /^[A-Za-z0-9._-]$/ }
    function below(pid,   p, n) {
      for (p = pid; p != "" && p != 0 && n < 64; p = parent[p]) {
        if (p == SELF) return 1
        n++
      }
      return 0
    }
    function names(s,   rest, at, before, after, skipped) {
      rest = s
      skipped = 0
      while ((at = index(rest, ROOT)) > 0) {
        before = (skipped + at > 1) ? substr(s, skipped + at - 1, 1) : ""
        after = substr(rest, at + length(ROOT), 1)
        if (!pathchar(before) && !pathchar(after)) return 1
        skipped += at
        rest = substr(rest, at + 1)
      }
      return 0
    }
    $1 == "C" {
      path = substr($0, length($2) + 4)
      if (path == ROOT || substr(path, 1, length(ROOT) + 1) == ROOT "/") cwd[$2] = 1
    }
    $1 == "P" {
      pid = $2; parent[pid] = $3; state[pid] = $4
      line = $0
      sub(/^P +[0-9]+ +[0-9]+ +[^ ]+ +/, "", line)
      cmd[pid] = line
    }
    END {
      for (p = SELF; p != "" && p != 0; p = parent[p]) skip[p] = 1
      for (pid in cmd) {
        if (skip[pid] || state[pid] ~ /^Z/ || below(pid)) continue
        if (cwd[pid] || names(cmd[pid])) print pid "\t" substr(cmd[pid], 1, 100)
      }
    }'
}

alive() {
  kill -0 "$1" 2>/dev/null || return 1
  case $(ps -o stat= -p "$1" 2>/dev/null) in
    "" | Z*) return 1 ;;
  esac
  return 0
}

wait_gone() {
  tries=0
  while [ "$tries" -lt "$1" ]; do
    any=0
    for p in $2; do
      if alive "$p"; then any=1; fi
    done
    [ "$any" -eq 0 ] && return 0
    sleep 0.2
    tries=$((tries + 1))
  done
}

tab=$(printf '\t')
for round in 1 2 3; do
  found=$(snapshot)
  [ -n "$found" ] || break
  pids=$(printf '%s\n' "$found" | cut -f1)
  kill -TERM $pids 2>/dev/null
  wait_gone 25 "$pids"
  survivors=""
  for p in $pids; do
    if alive "$p"; then survivors="$survivors $p"; fi
  done
  if [ -n "$survivors" ]; then
    kill -KILL $survivors 2>/dev/null
    wait_gone 10 "$survivors"
  fi
  printf '%s\n' "$found" | while IFS=$tab read -r pid cmd; do
    how=TERM
    case " $survivors " in *" $pid "*) how=KILL ;; esac
    if alive "$pid"; then how=ALIVE; fi
    printf '%s\t%s\t%s\n' "$pid" "$how" "$cmd"
  done
done
