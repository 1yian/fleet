# Packs all unlanded work of one worktree into <archive dir>/<name>.tar.zst and
# verifies it (spec section 20.5): every commit on the task branch that is not on
# the base branch (a git bundle), staged and unstaged changes (binary patches),
# untracked files that are not ignored, and a manifest. Prints the archive path.
# Safe to rerun: an existing archive is kept.
# Usage: sh -c "$(cat archive.sh)" archive <worktree> <base> <archive dir> <name>
set -eu
wt=$1 base=$2 arch=$3 name=$4
out="$arch/$name.tar.zst"
if [ -f "$out" ]; then echo "$out"; exit 0; fi
command -v zstd >/dev/null || { echo "zstd is required to archive" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dir="$work/$name"
mkdir -p "$arch" "$dir"
cd "$wt"
if [ "$(git rev-list --count "$base..HEAD")" -gt 0 ]; then
  git bundle create "$dir/commits.bundle" "$base..HEAD" 2>/dev/null
  git bundle verify "$dir/commits.bundle" >/dev/null 2>&1
fi
git diff --binary --cached >"$dir/staged.patch"
git diff --binary >"$dir/unstaged.patch"
git ls-files --others --exclude-standard -z | tar --null -T - -cf "$dir/untracked.tar"
printf '{"worktree":"%s","base":"%s","head":"%s"}\n' "$wt" "$base" "$(git rev-parse HEAD)" >"$dir/manifest.json"
tar -cf - -C "$work" "$name" | zstd -19 -q -o "$work/archive.tar.zst"
zstd -t -q "$work/archive.tar.zst"
mv "$work/archive.tar.zst" "$out"
echo "$out"
