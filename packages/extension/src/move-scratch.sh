# Moves a closed card's old scratch folder, ${FLEET_TMP_SOURCE_DIR:-/tmp}/fleet-c-<N>, off the
# host's /tmp (a memory filesystem on some hosts) to disk, and leaves a symlink at the old path.
# Nothing is deleted before a verified copy exists. Prints nothing when there is nothing to move,
# else one line of tab-separated fields:
#   moved   <old path> <new path> [<what stays behind>]
#   skipped <old path> <reason>
# Usage: sh -c "$(cat move-scratch.sh)" scratch <card>
set -u
case ${1:-} in "" | *[!0-9]*) echo "not a card number: ${1:-}" >&2; exit 1 ;; esac
name=fleet-c-$1
src=${FLEET_TMP_SOURCE_DIR:-/tmp}/$name
root=${FLEET_TMP_SCRATCH_DIR:-${FLEET_HOST_DIR:-$HOME/.fleet}/tmp-scratch}
case $root in /*) ;; *) root=$PWD/$root ;; esac
tab=$(printf '\t')

say() { printf '%s%s%s%s%s\n' "$1" "$tab" "$src" "$tab" "$2"; }
skip() { say skipped "$1"; exit 0; }

[ -L "$src" ] && exit 0
[ -d "$src" ] || exit 0

held() {
  if [ -d /proc/self ]; then
    {
      for d in /proc/[0-9]*; do
        pid=${d#/proc/}
        [ "$pid" = "$$" ] && continue
        readlink "$d/cwd" "$d"/fd/* 2>/dev/null | awk -v p="$pid" -v r="$1" '
          $0 == r || index($0, r "/") == 1 { print "held by a live process (pid " p ")"; exit }'
      done
      grep -lF -- "$1/" /proc/[0-9]*/maps 2>/dev/null | sed 's|^/proc/\([0-9]*\)/maps$|held by a live process (pid \1)|'
    } | head -n 1
  else
    lsof -w -t +D "$1" 2>&1 | awk '
      /^[0-9]+$/ { print "held by a live process (pid " $0 ")"; exit }
      NF { print "cannot tell whether a process holds it (" $0 ")"; exit }'
  fi
}

can_tell() {
  if [ -d /proc/self ]; then ls "/proc/$$/fd" >/dev/null 2>&1; else command -v lsof >/dev/null 2>&1; fi
}

rename_dir() { node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2" 2>/dev/null; }
link_dir() { node -e 'require("fs").symlinkSync(process.argv[1], process.argv[2])' "$1" "$2" 2>/dev/null; }

can_tell || skip "cannot tell whether a process holds it (no readable /proc and no lsof)"
command -v rsync >/dev/null 2>&1 || skip "rsync is not installed"

in_use=$(held "$src")
[ -z "$in_use" ] || skip "$in_use"

uid=$(id -u)
stuck=$(find "$src" \( ! -user "$uid" -o \( -type d ! -perm -u+w \) \) -print 2>/dev/null | head -n 1)
[ -z "$stuck" ] || skip "holds a file or folder this user cannot replace ($stuck)"

mkdir -p "$root" 2>/dev/null || skip "cannot make $root"
dest=$root/$name
k=0
while [ -e "$dest" ] || [ -L "$dest" ]; do
  k=$((k + 1))
  dest=$root/$name.$k
done
stage=$root/.moving-$name

if command -v ionice >/dev/null 2>&1; then low() { ionice -c2 -n7 nice -n 10 "$@"; }; else low() { nice -n 10 "$@"; }; fi
copy() { low rsync -aHc --numeric-ids --delete "$1/" "$stage/"; }
differs() { rsync -aHcn --numeric-ids --delete --itemize-changes "$1/" "$stage/" 2>&1 | head -n 1; }

copy "$src" >/dev/null 2>&1 || skip "the copy to $root failed"
[ -z "$(differs "$src")" ] || skip "the copy to $root did not match the original"

parked=$src.moved-$$
undo() {
  rename_dir "$parked" "$src" && skip "$1"
  skip "$1, and a new $src appeared, so the original is kept as $parked"
}

rename_dir "$src" "$parked" || skip "cannot rename the original"
in_use=$(held "$parked")
[ -z "$in_use" ] || undo "$in_use"
copy "$parked" >/dev/null 2>&1 && [ -z "$(differs "$parked")" ] || undo "it changed while it was copied"
rename_dir "$stage" "$dest" || undo "cannot place the copy at $dest"
if ! link_dir "$dest" "$src"; then
  [ -e "$src" ] || [ -L "$src" ] || undo "cannot link $src to $dest"
  say moved "$dest${tab}the path was made again during the move, so the original stays in $parked"
  exit 0
fi
if rm -rf "$parked" 2>/dev/null && [ ! -e "$parked" ]; then
  say moved "$dest"
else
  say moved "$dest${tab}part of the original stays in $parked"
fi
