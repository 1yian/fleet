import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, extname, matchesGlob, resolve } from "node:path";
import process from "node:process";
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
  return runNode(executable, [...arguments_, ...extra, ...paths], stdio);
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

function trackedPaths() {
  const result = spawnSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

function ignoredByConfig(path) {
  return config.ignorePatterns.some((pattern) =>
    matchesGlob(path, pattern.endsWith("/") ? `${pattern}**` : pattern),
  );
}

function selectedPaths(tracked) {
  const paths = tracked
    .filter((path) => sourceExtensions.includes(extname(path)))
    .filter((path) => !ignoredByConfig(path));
  if (!paths.length) throw new Error("No tracked source files selected.");
  const skipped = paths.filter((path) => /[._-]min\./.test(basename(path)));
  if (skipped.length)
    throw new Error(`Oxlint cannot lint minified filenames: ${skipped.join(", ")}`);
  return paths;
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
  const tracked = trackedPaths();
  const paths = selectedPaths(tracked);
  const baselines = baselineFailures(tracked);
  if (baselines.length) {
    for (const failure of baselines) console.error(failure);
    return 1;
  }
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
