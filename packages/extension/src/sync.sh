# Keeps a project clone current with its remote, ported from Firstmate's
# bin/fm-fleet-sync.sh and bin/fm-lock-lib.sh. It defines functions only: the
# extension appends the call (clones.ts and dispatch.ts). POSIX sh, because a host's
# sh may be dash.
#
# refresh_clone fetches origin with pruning, deletes local branches whose remote
# branch is gone, and fast-forwards a clean base branch to origin's. It never forces,
# stashes, or discards. A clone that is dirty, on another branch, detached with its
# own commits, or diverged is left alone and printed as a STUCK line. The one safe
# drift is healed: a clean detached HEAD with no commits of its own is put back on
# the base branch. Each line it prints starts with the label.

# fetch_origin <clone>: git fetch origin --prune. Sets $fetched to git's output.
# A fetch blocked by packed-refs.lock (left by a git that was killed mid-write) is
# retried 3 times a second apart, since a live owner soon exits. Then the lock is
# removed only when it is provably stale, and the fetch runs once more.
fetch_origin() {
  recovery=""
  fetched=$(git -C "$1" fetch origin --prune --quiet 2>&1) && return 0
  lock_error || return 1
  tries=0
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    sleep 1
    if fetched=$(git -C "$1" fetch origin --prune --quiet 2>&1); then
      recovery="the packed-refs lock cleared on its own"
      return 0
    fi
    lock_error || return 1
  done
  lock=$(git -C "$1" rev-parse --git-path packed-refs.lock) || return 1
  case $lock in /*) ;; *) lock="$1/$lock" ;; esac
  lock_stale "$lock" "$1" || return 1
  rm -f "$lock" || return 1
  fetched=$(git -C "$1" fetch origin --prune --quiet 2>&1) || return 1
  recovery="removed a stale packed-refs lock (no live holder)"
}

lock_error() {
  case $fetched in *"packed-refs.lock"*"File exists"*) return 0 ;; esac
  return 1
}

# lock_stale <lock> <dir>: true only when the lock exists, is at least 30 seconds
# old, and lsof proves that no process holds it or the clone. Any doubt (no lsof,
# an lsof error, an unreadable time) keeps the lock.
lock_stale() {
  [ -e "$1" ] || return 1
  command -v lsof >/dev/null 2>&1 || return 1
  for target in "$1" "$2"; do
    held=$(lsof -- "$target" 2>&1) && return 1
    [ $? -eq 1 ] && [ -z "$held" ] || return 1
  done
  if [ "$(uname)" = Darwin ]; then
    mtime=$(stat -f %m "$1") || return 1
  else
    mtime=$(stat -c %Y "$1") || return 1
  fi
  [ $(($(date +%s) - mtime)) -ge 30 ]
}

# prune_gone <clone> <label>: deletes each local branch whose remote branch is gone
# (its PR merged) unless a worktree has it checked out, including the clone's own.
# The tip is printed, so the branch can be made again.
prune_gone() {
  used=$(git -C "$1" worktree list --porcelain | sed -n 's#^branch refs/heads/##p')
  git -C "$1" for-each-ref --format='%(refname:short) %(upstream:track) %(objectname:short)' refs/heads |
    while read -r branch track sha; do
      [ "$track" = "[gone]" ] || continue
      if printf '%s\n' "$used" | grep -Fxq -- "$branch"; then continue; fi
      if git -C "$1" branch -D -- "$branch" >/dev/null 2>&1; then echo "$2: pruned $branch (was $sha)"; fi
    done
}

# stuck <clone> <label> <state>: the loud line for a clone left alone, with how far behind it is.
stuck() {
  behind=$(git -C "$1" rev-list --count "HEAD..$remote" 2>/dev/null) || behind="?"
  echo "$2: STUCK: on $3, $behind commits behind $remote - needs attention"
}

# refresh_clone <clone> <base> <label>
refresh_clone() {
  clone=$1 base=$2 label=$3 remote="origin/$2"
  [ -d "$clone" ] || { echo "$label: skipped: not a directory"; return 0; }
  top=$(git -C "$clone" rev-parse --show-toplevel 2>/dev/null) || { echo "$label: skipped: not a git repo"; return 0; }
  # Git looks upward, so a folder inside another repository would refresh that one.
  [ "$top" -ef "$clone" ] || { echo "$label: skipped: not a clone root (git would act on $top)"; return 0; }
  git -C "$clone" remote get-url origin >/dev/null 2>&1 || { echo "$label: skipped: no origin remote"; return 0; }
  if ! fetch_origin "$clone"; then
    echo "$label: skipped: fetch failed: $(printf '%s\n' "$fetched" | head -n 1)"
    return 0
  fi
  [ -z "$recovery" ] || echo "$label: recovered: $recovery"
  prune_gone "$clone" "$label"
  git -C "$clone" rev-parse -q --verify "$remote^{commit}" >/dev/null || { echo "$label: skipped: $remote does not exist"; return 0; }
  # A fleet home runs the fleet's code: it moves only with /updatefleet, which also builds and restarts.
  if [ -f "$clone/config/lane.json" ]; then
    behind=$(git -C "$clone" rev-list --count "HEAD..$remote")
    if [ "$behind" -gt 0 ]; then
      echo "$label: fleet home: $behind commits behind $remote, left for /updatefleet"
    else
      echo "$label: already current"
    fi
    return 0
  fi
  current=$(git -C "$clone" symbolic-ref -q --short HEAD) || current=""
  dirty=""
  [ -z "$(git -C "$clone" status --porcelain | head -n 1)" ] || dirty=" with uncommitted changes"
  recovered=""
  if [ "$current" != "$base" ]; then
    if [ -n "$current" ]; then stuck "$clone" "$label" "branch $current$dirty"; return 0; fi
    if [ -n "$dirty" ]; then stuck "$clone" "$label" "detached HEAD$dirty"; return 0; fi
    if ! git -C "$clone" merge-base --is-ancestor HEAD "$remote"; then
      stuck "$clone" "$label" "detached HEAD with unique commits"
      return 0
    fi
    if git -C "$clone" worktree list --porcelain | grep -Fxq -- "branch refs/heads/$base"; then
      stuck "$clone" "$label" "detached HEAD ($base checked out in another worktree)"
      return 0
    fi
    if git -C "$clone" rev-parse -q --verify "refs/heads/$base" >/dev/null &&
      ! git -C "$clone" merge-base --is-ancestor "refs/heads/$base" "$remote"; then
      stuck "$clone" "$label" "detached HEAD (local $base diverged from $remote)"
      return 0
    fi
    git -C "$clone" checkout -q "$base" 2>/dev/null || { stuck "$clone" "$label" "detached HEAD"; return 0; }
    recovered="recovered: re-attached $base, "
  elif [ -n "$dirty" ]; then
    stuck "$clone" "$label" "branch $base$dirty"
    return 0
  fi
  before=$(git -C "$clone" rev-parse --short HEAD)
  after=$(git -C "$clone" rev-parse --short "$remote")
  if [ "$(git -C "$clone" rev-parse HEAD)" = "$(git -C "$clone" rev-parse "$remote")" ]; then
    echo "$label: ${recovered}already current"
    return 0
  fi
  if ! git -C "$clone" merge-base --is-ancestor HEAD "$remote"; then
    stuck "$clone" "$label" "diverged $base"
    return 0
  fi
  if ! merged=$(git -C "$clone" merge -q --ff-only "$remote" 2>&1); then
    echo "$label: skipped: fast-forward failed: $(printf '%s\n' "$merged" | head -n 1)"
    return 0
  fi
  echo "$label: ${recovered}synced $before..$after"
}
