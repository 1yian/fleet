import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd, type Session } from "../support/cardd.ts";
import { newCard } from "../support/fleet.ts";
import { git } from "../support/remote.ts";
import { tempDir } from "../support/run-root.ts";

let cardd: Cardd;
let main: Session;
let leoToken: string;
let leo: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  main = await cardd.connect(cardd.addLane("main", undefined, "/homes/fleet-homes/main"));
  leoToken = cardd.addLane("leo", "main", "/homes/leo");
  leo = await cardd.connect(leoToken);
});
afterEach(async () => {
  await Promise.allSettled([main.close(), cardd.stop()]);
});

function ok(...args: string[]): string {
  const run = cardd.admin(...args);
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function refused(...args: string[]): string {
  const run = cardd.admin(...args);
  assert.equal(run.status, 1, run.stdout);
  return run.stderr;
}

async function untilLeoLeaves(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ok("lane", "list").includes("leo: parent main, mate exited")) {
    assert.ok(Date.now() < deadline, "leo's mate never showed as exited");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("lane list and project list show what is registered, with a lane's mate and card", () => {
  cardd.addProject("web", { maverick: "/clones/web", p620: "/p620/web" }, "acme/web");
  cardd.addProject("docs");
  assert.match(ok("lane", "list"), /^leo: parent main, mate idle, card c-1, home \/homes\/leo$/m);
  assert.match(
    ok("lane", "list"),
    /^main: no parent, mate idle, no lane card, home \/homes\/fleet-homes\/main$/m,
  );
  assert.equal(
    ok("project", "list"),
    [
      "docs: no-mistakes, yolo off, repo not set, no clones",
      "web: no-mistakes, yolo off, repo acme/web, maverick=/clones/web p620=/p620/web",
    ].join("\n"),
  );
});

test("adding a lane or a project that exists names the problem, not a SQLite constraint", () => {
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  assert.match(
    refused("lane", "add", "leo", "--home", "/homes/leo", "--parent", "main"),
    /lane leo is already in the registry: lane list shows it/,
  );
  const again = refused("project", "add", "web", "--delivery", "no-mistakes");
  assert.match(again, /project web is already in the registry: project list shows it/);
  assert.match(again, /project clone adds a host's clone/);
  assert.doesNotMatch(again, /SQLITE|constraint/i);
});

test("project add says whether it read the repo, and reads a clone on another host through --hosts", () => {
  const clone = join(tempDir("fleet-clone-"), "web");
  execFileSync("git", ["init", "-q", "-b", "main", clone]);
  git(clone, "remote", "add", "origin", "https://github.com/acme/web.git");
  const add = (path: string, ...more: string[]): string =>
    ok("project", "add", "web", "--delivery", "no-mistakes", "--clone", `p620=${path}`, ...more);

  const blind = add("/only/on/p620/web");
  assert.match(blind, /^web: added$/m);
  assert.match(blind, /^web: repo not set\. .*project repo web <owner>\/<name>.*--hosts/m);
  ok("project", "remove", "web");

  const sighted = add(clone, "--hosts", JSON.stringify({ p620: ["sh", "-c"] }));
  assert.equal(sighted, "web: added\nweb: repo acme/web");
});

test("lane home corrects a stale home, and refuses an unknown lane or a relative path", () => {
  assert.equal(
    ok("lane", "home", "leo", "/Users/yian/fleet-homes/leo"),
    "leo: home /homes/leo -> /Users/yian/fleet-homes/leo",
  );
  assert.match(ok("lane", "list"), /^leo: .*, home \/Users\/yian\/fleet-homes\/leo$/m);
  assert.match(
    refused("lane", "home", "ghost", "/homes/ghost"),
    /lane ghost is not in the registry/,
  );
  assert.match(refused("lane", "home", "leo", "homes/leo"), /must be an absolute path/);
  assert.match(ok("lane", "list"), /^leo: .*, home \/Users\/yian\/fleet-homes\/leo$/m);
});

test("lane remove refuses a lane that is in use, and removes one that never worked", async () => {
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  assert.match(refused("lane", "remove", "main"), /lane main is the parent of leo/);
  assert.match(refused("lane", "remove", "ghost"), /lane ghost is not in the registry/);
  assert.match(refused("lane", "remove", "leo"), /lane leo has a mate that is \w+: stop it first/);

  const card = await newCard(leo, "Which ads convert?", "scout");
  await leo.close();
  await untilLeoLeaves();
  assert.match(
    refused("lane", "remove", "leo"),
    new RegExp(`has open cards: c-${String(card.id)}`),
  );

  leo = await cardd.connect(leoToken);
  await leo.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "Search ads convert best.",
    archives: [],
    left: [],
  });
  await leo.close();
  await untilLeoLeaves();
  assert.match(
    refused("lane", "remove", "leo"),
    new RegExp(`has card history \\(c-${String(card.id)}.*\\)\\. Entries are append-only`),
  );

  const idle = cardd.addLane("idle", "main", "/homes/idle");
  assert.match(ok("lane", "list"), /^idle: parent main, mate exited, card c-\d+/m);
  assert.match(
    ok("lane", "remove", "idle"),
    /^idle: removed the lane and its lane card\. Its token no longer connects\./,
  );
  assert.doesNotMatch(ok("lane", "list"), /^idle:/m);
  const stranger = await cardd.connect(idle);
  assert.equal(stranger.welcome, undefined);
  assert.equal(cardd.addLane("idle", "main", "/homes/idle"), idle);
});
