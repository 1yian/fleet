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

holder() {
  if [ -d /proc/self ]; then
    for d in /proc/[0-9]*; do
      pid=${d#/proc/}
      [ "$pid" = "$$" ] && continue
      readlink "$d/cwd" "$d"/fd/* 2>/dev/null | awk -v p="$pid" -v r="$src" '
        $0 == r || index($0, r "/") == 1 { print "pid " p; exit }'
    done | head -n 1
    grep -lF -- "$src/" /proc/[0-9]*/maps 2>/dev/null | head -n 1 | sed 's|^/proc/\([0-9]*\)/maps$|pid \1|'
  else
    lsof -t +D "$src" 2>/dev/null | head -n 1 | sed 's/^/pid /'
  fi
}

can_tell() { [ -d /proc/self ] || command -v lsof >/dev/null 2>&1; }

held() { holder | head -n 1; }

can_tell || skip "cannot tell whether a process holds it (no /proc and no lsof)"
command -v rsync >/dev/null 2>&1 || skip "rsync is not installed"

in_use=$(held)
[ -z "$in_use" ] || skip "held by a live process ($in_use)"

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
copy() { low rsync -aH --numeric-ids --delete "$1/" "$stage/"; }
differs() { rsync -aHn --numeric-ids --delete --itemize-changes "$1/" "$stage/" 2>&1 | head -n 1; }

copy "$src" >/dev/null 2>&1 || skip "the copy to $root failed"
[ -z "$(differs "$src")" ] || skip "the copy to $root did not match the original"

in_use=$(held)
[ -z "$in_use" ] || skip "held by a live process during the copy ($in_use)"

parked=$src.moved-$$
[ ! -e "$parked" ] || skip "$parked exists"
mv "$src" "$parked" 2>/dev/null || skip "cannot rename the original"
if ! copy "$parked" >/dev/null 2>&1 || [ -n "$(differs "$parked")" ]; then
  mv "$parked" "$src"
  skip "it changed while it was copied"
fi
if [ -e "$dest" ] || [ -L "$dest" ] || ! mv "$stage" "$dest" 2>/dev/null; then
  mv "$parked" "$src"
  skip "cannot place the copy at $dest"
fi
if [ -e "$src" ] || [ -L "$src" ] || ! ln -s "$dest" "$src" 2>/dev/null; then
  if [ ! -e "$src" ] && [ ! -L "$src" ]; then mv "$parked" "$src"; skip "cannot link $src to $dest"; fi
  say moved "$dest${tab}the path was made again during the move, so the original stays in $parked"
  exit 0
fi
if rm -rf "$parked" 2>/dev/null && [ ! -e "$parked" ]; then
  say moved "$dest"
else
  say moved "$dest${tab}part of the original stays in $parked"
fi
