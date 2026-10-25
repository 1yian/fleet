import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { toolResults } from "../support/dispatch-lab.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { addRemote, git, landOnRemote, tip } from "../support/remote.ts";
import {
  configureMain,
  mateArgs,
  Scratch,
  secondMateProfileSkip,
  startMain,
} from "../support/scratch.ts";
import { pathWithout } from "../support/tool-stubs.ts";

const WAIT_MS = 120_000;
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TOOL_TRANSPORT = fileURLToPath(new URL("../support/tool-transport.ts", import.meta.url));
const HOST = hostname();

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let mainToken: string;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main");
  scratch.addLane("cleo", {
    url: cardd.url,
    token: cardd.addLane("cleo", "main"),
    args: mateArgs(h),
  });
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function refusal(args: readonly string[], env: Record<string, string>): string {
  try {
    scratch.fleet(args, { HERDR_SESSION: lab.name, ...env });
  } catch (error) {
    return error instanceof Error ? String(Reflect.get(error, "stderr")) : "";
  }
  return assert.fail(`fleet ${args.join(" ")} was not refused`);
}

const status = (): string => scratch.fleet(["status"], { HERDR_SESSION: lab.name });

test("fleet up starts no mate on a host that lacks tools, and reports every missing tool with the host and the fix", () => {
  const PATH = pathWithout("direnv", "zstd");
  assert.equal(
    refusal(["up"], { PATH }),
    [
      `zstd is missing on ${HOST}. Fix: brew install zstd (macOS) or apt install zstd (Debian)`,
      `direnv is missing on ${HOST}. Fix: brew install direnv (macOS) or apt install direnv (Debian)`,
      "",
    ].join("\n"),
  );
  assert.equal(status(), "cleo: down\n");
  assert.equal(
    refusal(["restart"], { PATH }),
    [
      `zstd is missing on ${HOST}. Fix: brew install zstd (macOS) or apt install zstd (Debian)`,
      `direnv is missing on ${HOST}. Fix: brew install direnv (macOS) or apt install direnv (Debian)`,
      "",
    ].join("\n"),
  );
  assert.equal(status(), "cleo: down\n");
});

test("fleet up refuses a missing gh executable and leaves the mate down", () => {
  const PATH = pathWithout("gh");
  assert.equal(
    refusal(["up"], { PATH }),
    `gh is missing on ${HOST}. Fix: brew install gh (macOS) or apt install gh (Debian)\n`,
  );
  assert.equal(status(), "cleo: down\n");
});

interface GhStub {
  readonly plain: { readonly code: number; readonly stderr: string } | "hang" | "killed";
  readonly json?: string;
}

function ghPath(name: string, stub: GhStub): string {
  const bin = join(h.dir, name);
  mkdirSync(bin);
  const gh = join(bin, "gh");
  const plain =
    stub.plain === "hang"
      ? "exec sleep 600"
      : stub.plain === "killed"
        ? "kill -KILL $$"
        : `printf '%s\\n' ${JSON.stringify(stub.plain.stderr)} >&2; exit ${String(stub.plain.code)}`;
  const json =
    stub.json === undefined
      ? "echo 'unknown flag: --json' >&2; exit 1"
      : `printf '%s\\n' ${JSON.stringify(stub.json)}; exit 0`;
  writeFileSync(
    gh,
    [
      "#!/bin/sh",
      "if [ \"$1\" = --version ]; then echo 'gh version 2.0.0'; exit 0; fi",
      "if [ \"$*\" = 'auth status --json hosts' ]; then",
      json,
      "fi",
      "if [ \"$*\" = 'auth status' ]; then",
      plain,
      "fi",
      "exit 3",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  return `${bin}:${process.env["PATH"] ?? ""}`;
}

const entry = (state: string, error?: string): string =>
  JSON.stringify({
    hosts: {
      "github.com": [
        {
          state,
          ...(error === undefined ? {} : { error }),
          active: true,
          host: "github.com",
          login: "1yian",
          tokenSource: "/home/x/.config/gh/hosts.yml",
          gitProtocol: "https",
        },
      ],
    },
  });

const LOGGED_OUT = "You are not logged into any GitHub hosts. To log in, run: gh auth login";
const INVALID =
  "github.com\n  X Failed to log in to github.com account 1yian\n  - The token in hosts.yml is invalid.";
const NOT_LOGGED_IN = `gh is not logged in on ${HOST}. Fix: gh auth login\n`;

test("fleet up refuses a gh that reports no logged-in host and names the login fix", () => {
  const PATH = ghPath("gh-logged-out", {
    plain: { code: 1, stderr: LOGGED_OUT },
    json: JSON.stringify({ hosts: {} }),
  });
  assert.equal(refusal(["up"], { PATH }), NOT_LOGGED_IN);
  assert.equal(status(), "cleo: down\n");
});

test("fleet up names the login fix when gh is too old for json and says it is logged out", () => {
  const PATH = ghPath("gh-old-logged-out", { plain: { code: 1, stderr: LOGGED_OUT } });
  assert.equal(refusal(["up"], { PATH }), NOT_LOGGED_IN);
});

test("fleet up names the login fix when GitHub rejects the stored token", () => {
  const PATH = ghPath("gh-rejected", {
    plain: { code: 1, stderr: INVALID },
    json: entry("error", 'non-200 OK status code: 401 Unauthorized body: "Bad credentials"'),
  });
  assert.equal(refusal(["up"], { PATH }), NOT_LOGGED_IN);
});

test("fleet up starts the mate when gh is logged in", () => {
  const PATH = ghPath("gh-authenticated", { plain: { code: 0, stderr: "" } });
  assert.equal(
    scratch.fleet(["up"], { HERDR_SESSION: lab.name, PATH }),
    "cleo: started in 2ndmate-cleo\n",
  );
});

function upWarning(PATH: string, extra: Record<string, string> = {}): string {
  const done = spawnSync("node", [scratch.launch, "up"], {
    encoding: "utf8",
    env: { ...process.env, HERDR_SESSION: lab.name, PATH, ...extra },
  });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, "cleo: started in 2ndmate-cleo\n");
  return done.stderr;
}

const warning = (reason: string): string =>
  `warning: could not check gh login on ${HOST}: ${reason}\n`;

test("fleet up warns, and still starts the mate, when GitHub is unreachable", () => {
  const PATH = ghPath("gh-unreachable", {
    plain: { code: 1, stderr: INVALID },
    json: entry(
      "error",
      'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused',
    ),
  });
  assert.equal(
    upWarning(PATH),
    warning(
      'github.com: Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused',
    ),
  );
});

test("fleet up never prints a token that gh echoes in its error", () => {
  const PATH = ghPath("gh-echoes-token", {
    plain: { code: 1, stderr: INVALID },
    json: entry(
      "error",
      "dial tcp: lookup failed for token ghp_abcdef0123456789 and github_pat_XYZ_123",
    ),
  });
  assert.equal(
    upWarning(PATH),
    warning("github.com: dial tcp: lookup failed for token ghp_*** and github_pat_***"),
  );
});

test("fleet up warns, and still starts the mate, when gh itself reports a timeout", () => {
  const PATH = ghPath("gh-reports-timeout", {
    plain: { code: 1, stderr: "github.com\n  X Timeout trying to log in to github.com" },
    json: entry("timeout", "context deadline exceeded"),
  });
  assert.equal(upWarning(PATH), warning("github.com: timed out"));
});

test("fleet up warns, and still starts the mate, when the gh probe hangs past its timeout", () => {
  const PATH = ghPath("gh-hangs", { plain: "hang" });
  assert.equal(
    upWarning(PATH, { FLEET_PROBE_TIMEOUT_MS: "1000" }),
    warning("gh auth status did not finish within 1s"),
  );
});

test("fleet up warns, and still starts the mate, when the gh probe is killed", () => {
  const PATH = ghPath("gh-killed", { plain: "killed" });
  assert.equal(upWarning(PATH), warning("gh was stopped by SIGKILL"));
});

test("fleet up warns, and still starts the mate, when gh fails for a reason that is not about login", () => {
  const PATH = ghPath("gh-broken", {
    plain: { code: 2, stderr: "gh: failed to read configuration: permission denied" },
  });
  assert.equal(
    upWarning(PATH),
    warning("gh auth status exited 2: gh: failed to read configuration: permission denied"),
  );
});

test("fleet up --maintenance never runs gh auth status, even when gh says logged out", () => {
  const PATH = ghPath("gh-logged-out-maintenance", {
    plain: { code: 1, stderr: LOGGED_OUT },
    json: JSON.stringify({ hosts: {} }),
  });
  assert.equal(
    scratch.fleet(["up", "--maintenance"], { HERDR_SESSION: lab.name, PATH }),
    "cleo: started in 2ndmate-cleo\n",
  );
});

const MODEL = { provider: "tier", model: "compact", thinking: "off" };

test("fleet up starts no mate whose conversation memory has no profile, and starts it once the profile exists", (t) => {
  if (secondMateProfileSkip) {
    t.skip(secondMateProfileSkip);
    return;
  }
  const home = join(`${scratch.root}.worktrees`, "lane-cleo");
  writeFileSync(
    join(home, "config", "optchat.json"),
    JSON.stringify({ enabled: true, memoryHome: "data/optchat", profile: "cleo" }),
  );
  const profile = join(realpathSync(home), "data", "optchat", "profiles", "cleo");
  const fix = `Fix: ${realpathSync(scratch.root)}/bin/fleet home memory cleo`;

  assert.equal(
    refusal(["up"], {}),
    `optchat of lane cleo has no AGENTS.md and config.json in profile ${profile} on ${HOST}. ${fix}\n`,
  );
  assert.equal(status(), "cleo: down\n");

  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "AGENTS.md"), "# cleo\n");
  assert.equal(
    refusal(["up"], {}),
    `optchat of lane cleo has no config.json in profile ${profile} on ${HOST}. ${fix}\n`,
  );
  const made = scratch.fleet(["home", "memory", "cleo", "--thinking", "off"]);
  assert.match(made, /cleo: profile: cleo, added config\.json\n/);
  assert.equal(readFileSync(join(profile, "AGENTS.md"), "utf8"), "# cleo\n");
  assert.deepEqual(JSON.parse(readFileSync(join(profile, "config.json"), "utf8")), {
    compactor: MODEL,
    subagent: MODEL,
  });
  assert.equal(
    scratch.fleet(["up"], { HERDR_SESSION: lab.name }),
    "cleo: started in 2ndmate-cleo\n",
  );
});

test("update_fleet stops before any change when a remote host lacks a tool, and names the tool, the host, and the fix", async () => {
  const here = new Scratch();
  const remote = addRemote(here.root);
  const clone = (name: string): Scratch => {
    const copy = new Scratch(name);
    git(copy.root, "remote", "add", "origin", remote);
    git(copy.root, "fetch", "-q", "origin");
    git(copy.root, "reset", "-q", "--hard", "origin/main");
    return copy;
  };
  const p620 = clone("fleet");
  const marker = join(here.parent, "p620-missing");
  writeFileSync(marker, "\n");
  configureMain(here, cardd.url, mainToken, {
    hosts: { p620: ["node", TOOL_TRANSPORT, marker] },
    roots: { p620: p620.root },
  });
  const ghost: Session = await cardd.connect(cardd.addLane("ghost", "main"));
  try {
    let result = "";
    h.onModel(() => ({ tool: "update_fleet", args: {} }), "mate");
    h.onModel((turns) => {
      result = toolResults(turns).at(-1) ?? "";
      return { text: "the update stopped" };
    }, "mate");
    await startMain(lab, here, h);
    const old = tip(here.root);
    landOnRemote(remote, "fleet-fix");
    writeFileSync(marker, "direnv\n");

    const card: unknown = await ghost.call("card.new", {
      title: "Update the fleet",
      kind: "scout",
    });
    const id: unknown = Reflect.get(Object(card), "id");
    await ghost.call("hold", {
      card: id,
      question: "Update?",
      options: ["Yes"],
    });
    await h.waitForCall(1, "mate", WAIT_MS);
    assert.equal(
      result,
      [
        "Fleet update stopped before any change: nothing was pulled, and no mate was restarted.",
        `- p620 (${realpathSync(p620.root)}): direnv is missing on ${HOST}. Fix: brew install direnv (macOS) or apt install direnv (Debian)`,
      ].join("\n"),
    );
    for (const home of [here.root, p620.root]) assert.equal(tip(home, "HEAD"), old);
  } finally {
    await ghost.close();
    here.dispose();
    p620.dispose();
  }
});
