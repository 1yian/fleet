import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Cdp } from "@fleet/protocol";
import { chromium } from "playwright";
import { AuthSite, PASSWORDS, STALL_PATH } from "../support/auth-site.ts";
import { HostLab } from "../support/browser-hosts.ts";
import type { StandInChrome, Target } from "../support/chrome.ts";
import { isRecord, parseRecord, type JsonRecord } from "../support/json.ts";
import { until } from "../support/login-fixtures.ts";
import { tempDir } from "../support/run-root.ts";
import type { SocksSsh } from "../support/socks-ssh.ts";
import { FleetChrome } from "../support/takeover-lab.ts";

let lab: HostLab | undefined;
let site: AuthSite | undefined;
const running: FleetChrome[] = [];

afterEach(async () => {
  for (const each of running.splice(0)) await each.stop();
  await lab?.stop();
  await site?.stop();
  lab = undefined;
  site = undefined;
});

const COLLIDING_KEYS = ["__proto__", "length", "key", "toString"];

const SIGNED_IN_BY_THE_WORKER = `(async () => {
  const answer = await fetch("/signin", {
    method: "POST",
    body: JSON.stringify({ user: "alice", password: ${JSON.stringify(PASSWORDS["alice"])} }),
  });
  localStorage.setItem("token", (await answer.json()).token);
  for (const key of ${JSON.stringify(COLLIDING_KEYS)}) localStorage.setItem(key, "kept " + key);
  window.marker = "host tab alive";
  return true;
})()`;

const WHAT_THE_HOST_TAB_HOLDS = `(async () => JSON.stringify({
  marker: window.marker ?? null,
  token: localStorage.getItem("token"),
  colliding: ${JSON.stringify(COLLIDING_KEYS)}.map((key) => localStorage.getItem(key)),
  pref: document.cookie.split("; ").find((pair) => pair.startsWith("pref=")) ?? null,
  me: await (await fetch("/me")).json(),
  html: document.documentElement.outerHTML,
}))()`;

async function aliceAtWork(
  address: (site: AuthSite) => string = (own) => own.url("/"),
): Promise<{ tab: Target; hostChrome: StandInChrome }> {
  lab = await HostLab.start([{ name: "alpha" }]);
  site = await AuthSite.start();
  const worker = await lab.worker("Users keep their session", "alpha");
  await worker.act({ action: "open", url: address(site) });
  const hostChrome = lab.chrome("alpha");
  const [tab] = await hostChrome.pages();
  assert.ok(tab !== undefined);
  await until(
    async () =>
      (await hostChrome.evaluate(tab.id, SIGNED_IN_BY_THE_WORKER)) === true ? true : undefined,
    "alice to be signed in on the host tab",
  );
  return { tab, hostChrome };
}

async function holds(hostChrome: StandInChrome, tab: Target): Promise<JsonRecord> {
  const text = await hostChrome.evaluate(tab.id, WHAT_THE_HOST_TAB_HOLDS);
  assert.equal(typeof text, "string");
  return parseRecord(String(text));
}

const user = (held: JsonRecord): unknown => {
  const me = held["me"];
  return isRecord(me) ? me["user"] : undefined;
};

function takeover(
  tab: Target,
  home?: string,
  ssh?: SocksSsh,
  select = tab.id.slice(0, 8),
): FleetChrome {
  assert.ok(lab !== undefined);
  const flags = ["--host", "alpha", "--endpoint", lab.chrome("alpha").endpoint, "--lane", "lane-a"];
  const started = FleetChrome.start(["take", select, ...flags], ssh, home);
  running.push(started);
  return started;
}

async function heldAsAlice(tab: Target, home?: string): Promise<FleetChrome> {
  const run = takeover(tab, home);
  const mac = await run.macPage();
  await mac.waitForFunction(() => document.getElementById("who")?.textContent === "alice");
  await run.letGo();
  return run;
}

const lockOf = (home: string): string => join(home, "lane-a", "takeover.lock");

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function endedWithNothingLeft(
  run: FleetChrome,
  port: string | undefined,
  hostChrome: StandInChrome,
  tab: Target,
  before: JsonRecord,
): Promise<void> {
  assert.equal(await run.exited, 0);
  assert.deepEqual(await holds(hostChrome, tab), before, "the worker's tab was not touched");
  await assert.rejects(fetch(`http://127.0.0.1:${String(port)}/json/version`), "Chrome was closed");
  const [forwarder] = run.ssh.forwardPids();
  assert.ok(forwarder !== undefined && forwarder > 0, "the proxy was started");
  await until(
    () => (isRunning(forwarder) ? undefined : true),
    "the ssh -D process of the takeover to end",
  );
  assert.equal(existsSync(lockOf(run.home)), false, "the lane lock was removed");
  assert.deepEqual(await cookiesLeftIn(run), [], "the Mac profile kept nothing of the session");
}

async function cookiesLeftIn(fleetChrome: FleetChrome): Promise<string[]> {
  const profile = join(fleetChrome.home, "lane-a", "profile");
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  try {
    return (await context.cookies()).map((cookie) => cookie.name);
  } finally {
    await context.close();
  }
}

test("a taken-over tab is the worker's session in a real Chrome of its own, routed through the host, and watch live still shows the worker's tab", async () => {
  const { tab, hostChrome } = await aliceAtWork();
  assert.ok(site !== undefined && lab !== undefined);
  const listed = FleetChrome.start(["list", "--host", "alpha", "--endpoint", hostChrome.endpoint]);
  running.push(listed);
  assert.equal(await listed.exited, 0);
  assert.match(listed.output, new RegExp(`.*Auth app +${site.origin}/`));

  const before = await holds(hostChrome, tab);
  const run = takeover(tab);
  await run.waitFor(/Chrome is open with .* signed in as the worker's tab, through ssh alpha/);
  assert.match(run.output, /Holding .*Auth app \(.*\): 3 cookies, 5 localStorage items\./);

  const mac = await run.macPage();
  assert.equal(mac.url(), site.url("/"));
  await mac.waitForFunction(() => document.getElementById("who")?.textContent === "alice");
  assert.equal(await mac.evaluate(() => localStorage.getItem("token")), before["token"]);
  assert.deepEqual(
    await mac.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), COLLIDING_KEYS),
    ["kept __proto__", "kept length", "kept key", "kept toString"],
    "items whose names are also names on Storage or Object were copied",
  );
  assert.ok(
    run.ssh.destinations().includes(`auth.example.test:${String(site.port)}`),
    "the Mac Chrome reached the site through the ssh tunnel, by a name only the host can resolve",
  );
  assert.deepEqual(
    run.ssh.forwards().map((line) => line.split(" ")[0]),
    ["alpha"],
  );

  assert.deepEqual(
    await holds(hostChrome, tab),
    before,
    "taking over did not touch the worker's tab",
  );
  const viewer = await lab.viewer("alpha");
  assert.ok((await lab.viewerTargets(viewer)).includes(tab.id));
  assert.ok((await lab.viewerPicture(viewer, tab.id)) > 0);

  await mac.fill("#user", "bob");
  await mac.fill("#pass", PASSWORDS["bob"] ?? "");
  await mac.click("#go");
  await mac.waitForFunction(() => document.getElementById("who")?.textContent === "bob");
  const macToken = await mac.evaluate(() => localStorage.getItem("token"));
  const macSid = (await mac.context().cookies()).find((cookie) => cookie.name === "sid")?.value;
  assert.ok(macSid !== undefined);
  await run.letGo();

  run.send("back");
  await run.waitFor(/Sent back to alpha: 3 cookies, 5 localStorage items\./);
  assert.equal(await run.exited, 0);
  const after = await until(async () => {
    const seen = await holds(hostChrome, tab);
    return user(seen) === "bob" ? seen : undefined;
  }, "the worker's tab to be bob");
  assert.equal(after["marker"], null, "the worker's tab was reloaded");
  assert.equal(after["token"], macToken);
  assert.deepEqual(after["colliding"], before["colliding"], "and were sent back");
  assert.equal(after["pref"], "pref=dark");

  const password = PASSWORDS["bob"] ?? "";
  assert.ok(
    !String(after["html"]).includes(password),
    "the password typed on the Mac never reached the worker's tab",
  );
  assert.ok(!run.output.includes(password));
  assert.ok(!run.output.includes(macSid), "the session cookie is not printed");
  assert.ok(!run.output.includes(macToken ?? ""), "the token is not printed");
  assert.deepEqual(site.signins, ["alice", "bob"]);
  assert.equal(existsSync(lockOf(run.home)), false, "the lane lock was removed");
  assert.match(run.output, /Removed the copied session of .* from the Mac profile\./);
  assert.deepEqual(
    await cookiesLeftIn(run),
    [],
    "the Mac profile kept nothing of the worker's session",
  );
});

test("back refuses a tab that the worker changed while it was held, and back --force replaces it", async () => {
  const { tab, hostChrome } = await aliceAtWork();
  const run = await heldAsAlice(tab);

  await hostChrome.evaluate(tab.id, `fetch("/pref?v=light").then(() => true)`);
  run.send("back");
  await run.waitFor(/Refused: the worker's tab changed while you held it \(pref \(cookie\)\)/);
  assert.equal(
    (await holds(hostChrome, tab))["marker"],
    "host tab alive",
    "a refusal does not reload the tab",
  );
  assert.equal((await holds(hostChrome, tab))["pref"], "pref=light");

  run.send("back --force");
  await run.waitFor(/Sent back to alpha/);
  assert.equal(await run.exited, 0);
  const after = await until(async () => {
    const seen = await holds(hostChrome, tab);
    return seen["marker"] === null ? seen : undefined;
  }, "the forced send-back to reload the tab");
  assert.equal(after["pref"], "pref=dark");
  assert.equal(user(after), "alice");
});

test("back refuses a session that the worker's tab renewed while it was held, though no value changed", async () => {
  const { tab, hostChrome } = await aliceAtWork();
  const run = await heldAsAlice(tab);

  await hostChrome.evaluate(tab.id, `fetch("/touch").then(() => true)`);
  run.send("back");
  await run.waitFor(/Refused: the worker's tab changed while you held it \(sid \(cookie\)\)/);
  assert.equal((await holds(hostChrome, tab))["marker"], "host tab alive");
  run.send("discard");
  assert.equal(await run.exited, 0);
});

test("discard leaves the worker's tab alone and removes the copy from the Mac profile", async () => {
  const { tab, hostChrome } = await aliceAtWork();
  const before = await holds(hostChrome, tab);
  const run = takeover(tab);
  const mac = await run.macPage();
  await mac.waitForFunction(() => document.getElementById("who")?.textContent === "alice");
  const port = (await run.waitFor(/Chrome debugging port: (\d+)/))[1];
  await run.letGo();

  run.send("discard");
  await run.waitFor(/Discarded: the worker's tab was not touched\./);
  assert.equal(await run.exited, 0);
  assert.deepEqual(await holds(hostChrome, tab), before);
  await assert.rejects(fetch(`http://127.0.0.1:${String(port)}/json/version`), "Chrome was closed");
  assert.deepEqual(await cookiesLeftIn(run), []);
});

test("two takeovers of one lane at once are refused by the lane lock before anything starts, and a text that is neither a tab number nor the start of a tab id is refused with the open tabs", async () => {
  const { tab } = await aliceAtWork();
  assert.ok(lab !== undefined && site !== undefined);
  const first = takeover(tab);
  await first.macPage();
  await first.letGo();
  assert.equal(readFileSync(lockOf(first.home), "utf8").trim(), String(first.pid));
  const second = takeover(tab, first.home, first.ssh);
  assert.equal(await second.exited, 1);
  assert.match(
    second.output,
    new RegExp(`lane lane-a is already being taken over by process ${String(first.pid)}:`),
  );
  assert.equal(first.ssh.forwardPids().length, 1, "the refused takeover started no proxy");
  assert.equal(readFileSync(lockOf(first.home), "utf8").trim(), String(first.pid));

  const nothing = FleetChrome.start([
    "take",
    "Auth app",
    "--host",
    "alpha",
    "--endpoint",
    lab.chrome("alpha").endpoint,
  ]);
  running.push(nothing);
  assert.equal(await nothing.exited, 1);
  assert.match(
    nothing.output,
    new RegExp(`no tab matches "Auth app":\\n1 +\\w+ +.*Auth app +${site.origin}/`),
  );
  assert.equal(existsSync(join(nothing.home, "default", "takeover.lock")), false);
});

test("a lock left by a process that is gone is taken over", async () => {
  const { tab } = await aliceAtWork();
  const home = tempDir("fleet-chrome-");
  mkdirSync(join(home, "lane-a"), { recursive: true });
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(!isRunning(gone));
  writeFileSync(lockOf(home), `${String(gone)}\n`);

  const run = await heldAsAlice(tab, home);
  assert.equal(readFileSync(lockOf(home), "utf8").trim(), String(run.pid));
  run.send("discard");
  assert.equal(await run.exited, 0);
  assert.equal(existsSync(lockOf(home)), false);
});

test("a takeover killed hard leaves a stale lock, and the next one is still refused while its Chrome runs", async () => {
  const { tab } = await aliceAtWork();
  assert.ok(lab !== undefined);
  const first = takeover(tab);
  await first.macPage();
  await first.letGo();
  const port = (await first.waitFor(/Chrome debugging port: (\d+)/))[1];
  const [forwarder] = first.ssh.forwardPids();
  process.kill(first.pid, "SIGKILL");
  await first.exited;
  try {
    assert.ok(existsSync(lockOf(first.home)), "a killed takeover cannot remove its lock");
    const second = takeover(tab, first.home);
    assert.equal(await second.exited, 1);
    assert.match(second.output, /a Chrome already runs with this profile/);
    assert.equal(existsSync(lockOf(first.home)), false, "the refused takeover left no lock");
  } finally {
    const cdp = await Cdp.connect(`http://127.0.0.1:${String(port)}`);
    await cdp.send("Browser.close").catch(() => undefined);
    cdp.close();
    if (forwarder !== undefined) process.kill(forwarder, "SIGTERM");
  }
});

test("takeovers that start together on a stale lock are not both let in", async () => {
  const { tab } = await aliceAtWork();
  const home = tempDir("fleet-chrome-");
  mkdirSync(join(home, "lane-a"), { recursive: true });
  writeFileSync(lockOf(home), `${String(spawnSync(process.execPath, ["-e", ""]).pid)}\n`);

  const runs = Array.from({ length: 4 }, () => takeover(tab, home));
  const refusal = /lane lane-a is (already being taken over|being recovered)/;
  const opened = (run: FleetChrome): boolean => run.output.includes("Chrome is open with");
  await until(
    () => (runs.every((run) => opened(run) || refusal.test(run.output)) ? true : undefined),
    "every takeover to be let in or refused",
  );
  const [winner, ...others] = runs.filter(opened);
  assert.ok(winner !== undefined && others.length === 0, "exactly one takeover was let in");
  assert.equal(readFileSync(lockOf(home), "utf8").trim(), String(winner.pid));
  for (const run of runs.filter((each) => each !== winner)) assert.equal(await run.exited, 1);
  assert.equal(readFileSync(lockOf(home), "utf8").trim(), String(winner.pid));
  await winner.letGo();
  winner.send("discard");
  assert.equal(await winner.exited, 0);
  assert.equal(existsSync(lockOf(home)), false);
});

test("a takeover that ends does not remove a lock that another process now holds", async () => {
  const { tab } = await aliceAtWork();
  const run = await heldAsAlice(tab);
  writeFileSync(lockOf(run.home), `${String(process.pid)}\n`);

  run.send("discard");
  assert.equal(await run.exited, 0);
  assert.equal(readFileSync(lockOf(run.home), "utf8").trim(), String(process.pid));
});

test("SIGTERM while a takeover is held discards it: the copy leaves the Mac profile, Chrome and the proxy end", async () => {
  const { tab, hostChrome } = await aliceAtWork();
  const before = await holds(hostChrome, tab);
  const run = takeover(tab);
  const mac = await run.macPage();
  await mac.waitForFunction(() => document.getElementById("who")?.textContent === "alice");
  const port = (await run.waitFor(/Chrome debugging port: (\d+)/))[1];
  await run.letGo();

  run.terminate();
  await run.waitFor(/Discarded: the worker's tab was not touched\./);
  await endedWithNothingLeft(run, port, hostChrome, tab, before);
});

test("Ctrl-C while the first page is still loading removes the copy as well, though Chrome and the terminal get the signal together", async () => {
  const { tab, hostChrome } = await aliceAtWork();
  assert.ok(site !== undefined);
  await hostChrome.evaluate(tab.id, `(history.pushState(null, "", "${STALL_PATH}"), true)`);
  const before = await holds(hostChrome, tab);
  const run = takeover(tab);
  const port = (await run.waitFor(/Chrome debugging port: (\d+)/))[1];
  await until(
    () => (site?.stallCount === 0 ? undefined : true),
    "the Mac Chrome to ask for the page that never answers",
  );
  assert.ok(!run.output.includes("Chrome is open with"), "the page was still loading");

  run.ctrlC();
  await run.waitFor(/Discarded: the worker's tab was not touched\./);
  await endedWithNothingLeft(run, port, hostChrome, tab, before);
});

async function heldAsBob(tab: Target): Promise<FleetChrome> {
  const run = takeover(tab);
  const mac = await run.macPage();
  await mac.waitForFunction(() => document.getElementById("who")?.textContent === "alice");
  await mac.fill("#user", "bob");
  await mac.fill("#pass", PASSWORDS["bob"] ?? "");
  await mac.click("#go");
  await mac.waitForFunction(() => document.getElementById("who")?.textContent === "bob");
  await run.letGo();
  return run;
}

test("discard closes the pages of the Mac Chrome first, so a page that keeps renewing the session cannot put it back", async () => {
  const { tab, hostChrome } = await aliceAtWork();
  const before = await holds(hostChrome, tab);
  const run = takeover(tab);
  const mac = await run.macPage();
  await mac.waitForFunction(() => document.getElementById("who")?.textContent === "alice");
  await mac.evaluate(() => {
    void (async () => {
      for (;;) {
        await fetch("/renew");
        localStorage.setItem("renewed", "again");
      }
    })();
  });
  const port = (await run.waitFor(/Chrome debugging port: (\d+)/))[1];
  await run.letGo();

  run.send("discard");
  await run.waitFor(/Discarded: the worker's tab was not touched\./);
  await endedWithNothingLeft(run, port, hostChrome, tab, before);
});

test("a line pasted after discard is ignored, so back does not send", async () => {
  const { tab, hostChrome } = await aliceAtWork();
  const before = await holds(hostChrome, tab);
  const run = await heldAsBob(tab);
  const reached = run.ssh.hostCommands();

  run.send("discard\nback");
  await run.waitFor(/Discarded: the worker's tab was not touched\./);
  assert.equal(await run.exited, 0);
  assert.ok(!/Sent back|failed:/.test(run.output), "back did not run after discard");
  assert.equal(run.ssh.hostCommands(), reached, "nothing reached the host after discard");
  assert.deepEqual(await holds(hostChrome, tab), before);
});

test("input that ends right after back still lets the send finish", async () => {
  const { tab, hostChrome } = await aliceAtWork();
  const run = await heldAsBob(tab);

  run.send("back");
  run.endInput();
  await run.waitFor(/Sent back to alpha/);
  assert.equal(await run.exited, 0);
  assert.ok(
    !run.output.includes("Discarded"),
    "the end of input did not turn the send into a discard",
  );
  const after = await until(async () => {
    const seen = await holds(hostChrome, tab);
    return user(seen) === "bob" ? seen : undefined;
  }, "the worker's tab to be bob");
  assert.equal(after["marker"], null, "the worker's tab was reloaded");
});

test("the host's own loopback addresses go through the host as well, and the number that list prints selects the tab", async () => {
  const { tab } = await aliceAtWork((own) => `http://127.0.0.1:${String(own.port)}/`);
  assert.ok(site !== undefined);
  const run = takeover(tab, undefined, undefined, "1");
  const mac = await run.macPage();
  await mac.waitForFunction(() => document.getElementById("who")?.textContent === "alice");
  assert.equal(mac.url(), `http://127.0.0.1:${String(site.port)}/`);
  assert.ok(
    run.ssh.destinations().includes(`127.0.0.1:${String(site.port)}`),
    "Chrome sent a loopback address to the proxy and did not open it on the Mac",
  );
  await run.letGo();
  run.send("discard");
  assert.equal(await run.exited, 0);
});
