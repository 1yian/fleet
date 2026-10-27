import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));

const GREEN = [
  { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
  { __typename: "StatusContext", context: "legacy-ci", state: "SUCCESS" },
];
const RED_AND_PENDING = [
  { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "FAILURE" },
  { __typename: "CheckRun", name: "ci-ok", status: "IN_PROGRESS", conclusion: "" },
  { __typename: "StatusContext", context: "legacy-ci", state: "PENDING" },
];

let fleet: Fleet;
let h: Harness;
let bin: string;
let merged: string;
let checks: string;
let hostSeen: string;

beforeEach(async () => {
  fleet = await startFleet({});
  h = await Harness.start();
  bin = join(h.dir, "bin");
  merged = join(h.dir, "merged");
  checks = join(h.dir, "checks.json");
  hostSeen = join(h.dir, "host");
  mkdirSync(bin);
  const file = join(bin, "gh");
  writeFileSync(
    file,
    `#!/bin/sh
case "$1 $2" in
  "pr view") case "$*" in *"{"*) echo "no such repository" >&2; exit 1 ;; esac; printf '%s' "$GH_HOST" > "${hostSeen}"; cat "${checks}" ;;
  *) touch "${merged}" ;;
esac
`,
  );
  chmodSync(file, 0o755);
});
afterEach(async () => {
  const stopped = await Promise.allSettled([h.stop(), fleet.cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

async function workerRuns(command: string, rollup: unknown): Promise<string> {
  writeFileSync(
    checks,
    JSON.stringify({ headRefOid: "abc123def4567890", statusCheckRollup: rollup }),
  );
  h.onModel(() => ({ tool: "bash", args: { command } }));
  h.onModel(() => ({ text: "done" }));
  const token = await begin(fleet.main, await newCard(fleet.main, "Merge it"));
  const pi = h.startPi(
    "worker",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: token,
      FLEET_ROLE: "worker",
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    },
    [EXTENSION, SHELL],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the worker to connect");
  pi.prompt("merge it");
  await h.waitForCall(1);
  return JSON.stringify(h.calls[1]);
}

const SHA = "abc123def4567890";
const BIND = `--match-head-commit ${SHA}`;
const MERGES: readonly [string, string][] = [
  [`gh pr merge https://github.com/o/r/pull/7 --squash ${BIND}`, "url"],
  [`gh pr merge 7 --admin --squash ${BIND}`, "admin"],
  [`gh pr merge --auto --merge ${BIND}`, "auto"],
  [`gh pr merge my-branch -R o/r --rebase ${BIND}`, "branch with repo"],
  [`echo go && (gh pr merge 7 --squash ${BIND})`, "compound"],
  [`gh -R o/r pr merge 7 --squash ${BIND}`, "global repo flag"],
  [`gh pr \\\n merge 7 --squash ${BIND}`, "line continuation"],
  [`gh api -X PUT repos/o/r/pulls/7/merge -f merge_method=squash -f sha=${SHA}`, "api put"],
  [`gh api \\\n --method PUT repos/o/r/pulls/7/merge -f sha=${SHA}`, "api continuation"],
];

for (const [command, label] of MERGES) {
  test(`a worker is refused a merge (${label}) while a check is red or pending`, async () => {
    const result = await workerRuns(command, RED_AND_PENDING);
    assert.match(result, /not every check on the PR's head commit abc123def456/);
    assert.match(result, /e2e: failure/);
    assert.match(result, /ci-ok: in progress/);
    assert.match(result, /legacy-ci: pending/);
    assert.match(result, /run_long/);
    assert.equal(existsSync(merged), false);
  });
}

for (const [command, label] of MERGES) {
  test(`a worker may merge (${label}) when every check is green`, async () => {
    const result = await workerRuns(command, GREEN);
    assert.doesNotMatch(result, /refused/);
    assert.equal(existsSync(merged), true);
  });
}

test("a worker may merge a PR that has no checks", async () => {
  const result = await workerRuns(`gh pr merge 7 --squash ${BIND}`, []);
  assert.doesNotMatch(result, /refused/);
  assert.equal(existsSync(merged), true);
});

test("a worker is refused a GraphQL merge", async () => {
  const result = await workerRuns(
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }'",
    GREEN,
  );
  assert.match(result, /GraphQL merge mutation/);
  assert.equal(existsSync(merged), false);
});

test("a worker is refused a merge when the check lookup fails", async () => {
  const result = await workerRuns(`gh pr merge 7 --squash ${BIND}`, null);
  assert.match(result, /could not look up the PR's checks/);
  assert.equal(existsSync(merged), false);
});

for (const [command, label] of [
  ["gh pr merge 7 --squash", "pr"],
  ["gh pr merge 7 --squash --match-head-commit 0000000", "pr with another sha"],
  ["gh api -X PUT repos/o/r/pulls/7/merge", "api"],
] as const) {
  test(`a worker is refused a green merge not bound to the head commit (${label})`, async () => {
    const result = await workerRuns(command, GREEN);
    assert.match(result, /not bound to it/);
    assert.match(result, /abc123def4567890/);
    assert.equal(existsSync(merged), false);
  });
}

for (const [command, label] of [
  ["GH_REPO=x/y gh pr merge 7 --squash", "GH_REPO"],
  ["cd /tmp && gh pr merge 7 --squash", "cd with an unnamed repo"],
] as const) {
  test(`a worker is refused a merge whose repository cannot be resolved (${label})`, async () => {
    const result = await workerRuns(`${command} ${BIND}`, GREEN);
    assert.match(result, /cannot be resolved faithfully/);
    assert.equal(existsSync(merged), false);
  });
}

for (const [command, label] of [
  ["gh api graphql --input mutation.json", "input file"],
  ["gh api graphql -F query=@mutation.graphql", "query file"],
] as const) {
  test(`a worker is refused a GraphQL call whose query cannot be read (${label})`, async () => {
    const result = await workerRuns(command, GREEN);
    assert.match(result, /Inline the query/);
    assert.equal(existsSync(merged), false);
  });
}

for (const [command, label] of [
  ["gh pr merge 7 --disable-auto", "disable auto-merge"],
  ["gh api repos/o/r/pulls/7/merge", "merge status read"],
] as const) {
  test(`a worker may run a non-merging command while checks are red (${label})`, async () => {
    const result = await workerRuns(command, RED_AND_PENDING);
    assert.doesNotMatch(result, /refused/);
    assert.equal(existsSync(merged), true);
  });
}

for (const [command, label] of [
  [
    "gh api https://api.github.com/graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
    "absolute endpoint",
  ],
  ['gh api graphql -f query="$QUERY"', "shell variable"],
  ['gh api graphql -f query="mutation { $(cat q) }"', "command substitution"],
  ["gh api graphql -f query=`cat mutation.graphql`", "backtick substitution"],
] as const) {
  test(`a worker is refused a GraphQL call it cannot classify (${label})`, async () => {
    const result = await workerRuns(command, GREEN);
    assert.match(result, /GraphQL merge mutation/);
    assert.equal(existsSync(merged), false);
  });
}

test("a worker may run a literal GraphQL query that declares variables", async () => {
  const result = await workerRuns(
    "gh api graphql -f query='query($id: ID!) { node(id: $id) { id } }'",
    GREEN,
  );
  assert.doesNotMatch(result, /refused/);
  assert.equal(existsSync(merged), true);
});

test("a disable-auto on the next line does not exempt the merge before it", async () => {
  const result = await workerRuns(
    `gh pr merge 7 --admin --squash ${BIND}\ngh pr merge 8 --disable-auto`,
    RED_AND_PENDING,
  );
  assert.match(result, /not every check/);
  assert.equal(existsSync(merged), false);
});

test("the last method flag decides whether a REST call merges", async () => {
  const result = await workerRuns(
    "gh api -X GET --method PUT repos/o/r/pulls/7/merge",
    RED_AND_PENDING,
  );
  assert.match(result, /not every check/);
  assert.equal(existsSync(merged), false);
});

test("a REST merge is looked up on the host of its absolute endpoint", async () => {
  const result = await workerRuns(
    `gh api https://enterprise.example/api/v3/repos/o/r/pulls/7/merge -X PUT -f sha=${SHA}`,
    GREEN,
  );
  assert.doesNotMatch(result, /refused/);
  assert.equal(readFileSync(hostSeen, "utf8"), "enterprise.example");
});

test("a REST merge with placeholders is resolved against the current repository", async () => {
  const result = await workerRuns(
    "gh api -X PUT repos/{owner}/{repo}/pulls/7/merge",
    RED_AND_PENDING,
  );
  assert.match(result, /not every check/);
  assert.equal(existsSync(merged), false);
});

test("a worker may run an explicit GET with fields against the merge endpoint", async () => {
  const result = await workerRuns(
    "gh api -X GET repos/o/r/pulls/7/merge -f foo=bar",
    RED_AND_PENDING,
  );
  assert.doesNotMatch(result, /refused/);
  assert.equal(existsSync(merged), true);
});

test("a worker is refused a merge whose arguments hide a flag behind a backslash escape", async () => {
  const result = await workerRuns(
    `gh pr merge 7 --admin --squash ${BIND} --body Disable\\ --disable-auto`,
    GREEN,
  );
  assert.match(result, /backslash escape/);
  assert.equal(existsSync(merged), false);
});

for (const [command, label] of [
  [`gh api -X PUT 'repos/{owner}/other/pulls/7/merge' -f sha=${SHA}`, "partial owner placeholder"],
  [`gh api -X PUT 'repos/other/{repo}/pulls/7/merge' -f sha=${SHA}`, "partial repo placeholder"],
] as const) {
  test(`a worker is refused a REST merge with a partly resolved repository (${label})`, async () => {
    const result = await workerRuns(command, null);
    assert.match(result, /could not look up/);
    assert.equal(existsSync(merged), false);
  });
}

test("a worker is refused a REST merge whose sha is only a query parameter beside --input", async () => {
  const result = await workerRuns(
    `gh api -X PUT repos/o/r/pulls/7/merge --input body.json -f sha=${SHA}`,
    GREEN,
  );
  assert.match(result, /not bound to it/);
  assert.equal(existsSync(merged), false);
});

test("a worker is refused a REST merge whose endpoint carries a query string", async () => {
  const result = await workerRuns(
    `gh api -X PUT 'repos/o/r/pulls/7/merge?merge_method=squash' -f sha=${SHA}`,
    RED_AND_PENDING,
  );
  assert.match(result, /not every check/);
  assert.equal(existsSync(merged), false);
});

test("a worker may run a readable non-merging GraphQL query that contains a backslash", async () => {
  const result = await workerRuns(
    "gh api graphql -f query='{ viewer { login } }' --jq '.data.viewer.login + \"\\n\"'",
    RED_AND_PENDING,
  );
  assert.doesNotMatch(result, /refused/);
  assert.equal(existsSync(merged), true);
});

test("a worker may run a non-merging GraphQL query that mentions a merge setting and a backslash", async () => {
  const result = await workerRuns(
    'gh api graphql -f query=\'{ repository(owner:"o", name:"r") { mergeCommitAllowed } }\' --jq \'.data.repository.mergeCommitAllowed | tostring + "\\n"\'',
    RED_AND_PENDING,
  );
  assert.doesNotMatch(result, /refused/);
  assert.equal(existsSync(merged), true);
});

for (const [command, label] of [
  ["git commit -m 'fix gh pr merge guard'", "pr merge"],
  ["git commit -m 'document gh api -X PUT repos/o/r/pulls/7/merge'", "api merge"],
] as const) {
  test(`a worker may commit a message that mentions a merge command (${label})`, async () => {
    const result = await workerRuns(command, null);
    assert.doesNotMatch(result, /refused/);
  });
}

for (const [command, label] of [
  [`if true; then gh pr merge 7 --admin --squash ${BIND}; fi`, "then"],
  [`for i in 1; do gh pr merge 7 --squash ${BIND}; done`, "do"],
  [`if false; then true; else gh pr merge 7 --squash ${BIND}; fi`, "else"],
] as const) {
  test(`a worker is refused a red merge after a shell keyword (${label})`, async () => {
    const result = await workerRuns(command, RED_AND_PENDING);
    assert.match(result, /not every check/);
    assert.equal(existsSync(merged), false);
  });
}
