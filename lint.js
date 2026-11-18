import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import config from "./.oxlintrc.json" with { type: "json" };

const executable = fileURLToPath(import.meta.resolve("oxlint/package.json")).replace(
  /package.json$/,
  "bin/oxlint",
);
const compiler = fileURLToPath(import.meta.resolve("tsrs/package.json")).replace(
  /package.json$/,
  "bin/tsrs",
);
const arguments_ = ["--disable-nested-config", "--no-ignore", "--max-warnings", "0"];
const sourceExtensions = [".js", ".cjs", ".mjs", ".ts", ".tsx", ".mts", ".cts"];
const suppressionBaseline = "oxlint-suppressions.json";

function runNode(script, args, stdio) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status === null) throw new Error(`${script} did not exit normally.`);
  return result;
}

function runOxlint(extra, paths, stdio) {
  return runNode(executable, [...arguments_, ...extra, "--", ...paths], stdio);
}

function policyList(name) {
  const values = config.settings?.fleet?.[name];
  if (
    !Array.isArray(values) ||
    !values.length ||
    !values.every((value) => typeof value === "string" && value.length)
  )
    throw new Error(`Missing or invalid Fleet ${name} policy.`);
  return values;
}

function normalizedPath(path) {
  return realpathSync(resolve(path));
}

function discoverProgram(project) {
  const result = runNode(compiler, ["-p", project, "--listFilesOnly", "--pretty", "false"], "pipe");
  if (result.status !== 0 || result.stderr)
    throw new Error(`tsrs discovery failed for ${project}: ${result.stderr || result.stdout}`);
  const paths = result.stdout.trim().split("\n");
  if (!paths[0]) throw new Error(`tsrs discovered no files for ${project}.`);
  return paths.map(normalizedPath);
}

function membershipFailures(paths) {
  const extensions = policyList("projectExtensions");
  const files = new Set(policyList("projects").flatMap(discoverProgram));
  return paths
    .filter((path) => extensions.includes(extname(path)))
    .filter((path) => !files.has(normalizedPath(path)))
    .map(
      (path) =>
        `${path}: error fleet/project-membership: File is outside every configured TypeScript program.`,
    );
}

function preflightFile(path, forbiddenDirectives) {
  const source = readFileSync(path, "utf8");
  const parsed = parseSync(path, source);
  const failures = parsed.errors.map((error) => `${path}: ${error.message}`);
  for (const comment of parsed.comments) {
    if (!forbiddenDirectives.test(comment.value)) continue;
    const before = source.slice(0, comment.start).split("\n");
    failures.push(
      `${path}:${before.length}:${before.at(-1).length + 1}: error fleet/no-inline-config: Inline lint configuration is not allowed.`,
    );
  }
  return failures;
}

function forbiddenDirectivePattern() {
  const policy = config.settings?.fleet?.forbiddenDirectives;
  if (typeof policy !== "string" || !policy)
    throw new Error("Missing inline configuration policy.");
  return new RegExp(policy);
}

function escapedPath(text) {
  return JSON.stringify(text).slice(1, -1);
}

function decodePath(bytes) {
  let path;
  try {
    path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    const escaped = [...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`).join("");
    throw new Error(`${escaped}: error fleet/unsupported-path: Tracked path is not valid UTF-8.`);
  }
  if (/[\n\r]/.test(path))
    throw new Error(
      `${escapedPath(path)}: error fleet/unsupported-path: Tracked path contains a line break.`,
    );
  return path;
}

function gitPaths() {
  const result = spawnSync("git", ["ls-files", "-z", "--cached"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stderr.length)
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  const paths = [];
  let start = 0;
  for (let end = 0; end < result.stdout.length; end += 1) {
    if (result.stdout[end] !== 0) continue;
    if (end > start) paths.push(decodePath(result.stdout.subarray(start, end)));
    start = end + 1;
  }
  return paths;
}

function existsInWorkingTree(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function unsupportedPattern(pattern) {
  return new Error(
    `${pattern}: error fleet/unsupported-ignore-pattern: Unsupported glob syntax in ignorePatterns.`,
  );
}

function segmentMatcher(segment, pattern) {
  if (!segment || /[?[\]{}\\]|\*\*/.test(segment)) throw unsupportedPattern(pattern);
  const source = segment
    .split("*")
    .map((part) => part.replace(/[.+^$()|]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`);
}

function ignoreMatchers() {
  return config.ignorePatterns.map((pattern) => {
    if (/^[#!/]|\s$/.test(pattern)) throw unsupportedPattern(pattern);
    const directoryOnly = pattern.endsWith("/");
    const body = pattern.replace(/^\*\*\//, "").replace(/\/$/, "");
    return {
      anywhere: pattern.startsWith("**/") || !body.includes("/"),
      directoryOnly,
      segments: body.split("/").map((segment) => segmentMatcher(segment, pattern)),
    };
  });
}

function ignoredBy(matchers, path) {
  const parts = path.split("/");
  return matchers.some(({ anywhere, directoryOnly, segments }) => {
    const limit = directoryOnly ? parts.length - 1 : parts.length;
    const last = anywhere ? limit - segments.length : 0;
    for (let start = 0; start <= last; start += 1)
      if (segments.every((segment, offset) => segment.test(parts[start + offset]))) return true;
    return false;
  });
}

function minifiedName(path) {
  return /[._-]min\./.test(basename(path));
}

function discover() {
  const matchers = ignoreMatchers();
  const existing = gitPaths().filter(existsInWorkingTree);
  const sources = existing.filter((path) => sourceExtensions.includes(extname(path)));
  return {
    tracked: existing.filter((path) => !ignoredBy(matchers, path)),
    candidates: sources.filter((path) => !minifiedName(path)),
  };
}

function selectedPaths(tracked) {
  const paths = tracked.filter((path) => sourceExtensions.includes(extname(path)));
  if (!paths.length) throw new Error("No tracked source files selected.");
  return paths;
}

function verifyAgainstOxlint(candidates, paths) {
  const selection = runOxlint(["--debug", "files"], candidates, "pipe");
  if (selection.status !== 0 || selection.stderr)
    throw new Error(`Oxlint selection failed: ${selection.stderr || selection.stdout}`);
  const reported = new Set(selection.stdout.split("\n").filter(Boolean));
  const expected = new Set(paths);
  const differing = [
    ...paths.filter((path) => !reported.has(path)),
    ...[...reported].filter((path) => !expected.has(path)),
  ];
  if (differing.length)
    throw new Error(`Oxlint selected a different file list than lint.js: ${differing.join(", ")}`);
}

function minifiedNameFailures(paths) {
  return paths
    .filter(minifiedName)
    .map(
      (path) =>
        `${path}: error fleet/minified-name: Oxlint cannot lint files with a minified filename.`,
    );
}

function baselineFailures(tracked) {
  const found = tracked.filter((path) => basename(path) === suppressionBaseline);
  if (existsSync(suppressionBaseline) && !found.includes(suppressionBaseline))
    found.push(suppressionBaseline);
  return found.map(
    (path) =>
      `${path}: error fleet/no-suppression-baseline: Bulk suppression baselines are not allowed.`,
  );
}

function lint() {
  if (process.argv.length !== 2)
    throw new Error("npm run lint always checks the complete project.");
  const { tracked, candidates } = discover();
  const paths = selectedPaths(tracked);
  const refusals = [...baselineFailures(tracked), ...minifiedNameFailures(paths)];
  if (refusals.length) {
    for (const failure of refusals) console.error(failure);
    return 1;
  }
  verifyAgainstOxlint(candidates, paths);
  const forbiddenDirectives = forbiddenDirectivePattern();
  const failures = [
    ...membershipFailures(paths),
    ...paths.flatMap((path) => preflightFile(path, forbiddenDirectives)),
  ];
  for (const failure of failures) console.error(failure);
  const result = runOxlint(["--type-aware"], paths, "inherit");
  return failures.length ? 1 : result.status;
}

try {
  process.exitCode = lint();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
