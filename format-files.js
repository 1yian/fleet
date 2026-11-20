import { spawnSync } from "node:child_process";
import console from "node:console";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const paths = process.argv.slice(2);
const invalid = paths.find(
  (path) =>
    !lstatSync(path, { throwIfNoEntry: false })?.isFile() ||
    realpathSync.native(path) !== resolve(path),
);
if (invalid !== undefined) {
  console.error(
    `format:files: ${JSON.stringify(invalid)} must be a regular file without symlinks.`,
  );
  process.exitCode = 1;
} else {
  const targets = paths.map((path) => (path.startsWith("!") ? `./${path}` : path));
  const result = spawnSync(
    "oxfmt",
    ["--check", "--no-error-on-unmatched-pattern", "--", ...targets],
    {
      stdio: "inherit",
    },
  );
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
