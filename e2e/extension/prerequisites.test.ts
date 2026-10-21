import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { toolResults } from "../support/dispatch-lab.ts";
import { installFakeLoader, preparePackage } from "../support/fake-optchat.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { addRemote, git, landOnRemote, tip } from "../support/remote.ts";
import { configureMain, mateArgs, Scratch, startMain } from "../support/scratch.ts";
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
  assert.equal(refusal(["restart"], { PATH }).split("\n").length, 3);
  assert.equal(status(), "cleo: down\n");
});

test("fleet up starts no mate whose conversation-memory package is missing or stale, and starts it once the package is prepared", () => {
  const agent = join(h.dir, "agent");
  installFakeLoader(agent);
  const home = join(`${scratch.root}.worktrees`, "lane-cleo");
  const files = join(home, "config", "optchat");
  const packagePath = join(realpathSync(home), "config", "optchat", "package");
  writeFileSync(
    join(home, "config", "optchat.json"),
    JSON.stringify({ enabled: true, package: "config/optchat/package", profile: "cleo" }),
  );
  const env = { PI_CODING_AGENT_DIR: agent };
  const fix = `Fix: ${scratch.root}/bin/fleet home memory cleo`;

  assert.equal(
    refusal(["up"], env),
    `optchat of lane cleo is missing its package ${packagePath} on ${HOST}. ${fix}\n`,
  );

  preparePackage(join(files, "package"), false);
  assert.equal(
    refusal(["up"], env),
    `optchat of lane cleo has a stale or broken package ${packagePath} on ${HOST}: OptChat patched fingerprint differs: src/index.ts. ${fix}\n`,
  );
  assert.equal(status(), "cleo: down\n");

  preparePackage(join(files, "package"), true);
  assert.equal(
    scratch.fleet(["up"], { HERDR_SESSION: lab.name, ...env }),
    "cleo: started in 2ndmate-cleo\n",
  );
});

test("fleet up names a loader that is not installed when memory is on", () => {
  const agent = join(h.dir, "agent");
  mkdirSync(agent, { recursive: true });
  const home = join(`${scratch.root}.worktrees`, "lane-cleo");
  writeFileSync(
    join(home, "config", "optchat.json"),
    JSON.stringify({ enabled: true, package: "config/optchat/package", profile: "cleo" }),
  );
  assert.match(
    refusal(["up"], { PI_CODING_AGENT_DIR: agent }),
    new RegExp(`^optchat of lane cleo has no loader in ${agent} on ${HOST}\\. Fix: `),
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
