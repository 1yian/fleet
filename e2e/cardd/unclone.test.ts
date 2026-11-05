import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CardSchema, check, OPS } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { Scratch } from "../support/scratch.ts";

test("remove deletes registered projects and refresh targets but preserves closed card history", async () => {
  const scratch = new Scratch();
  const cardd = await Cardd.start();
  const remove = (project: string) =>
    spawnSync(
      "node",
      [
        join(scratch.root, "packages/cardd/src/main.ts"),
        "project",
        "remove",
        project,
        "--db",
        cardd.db,
      ],
      { encoding: "utf8" },
    );
  try {
    const token = cardd.addLane("main");
    const main = await cardd.connect(token);
    cardd.addProject("meta-cx", { maverick: scratch.root, p620: scratch.root }, "acme/meta-cx");
    cardd.addProject("ces", { p620: scratch.root }, "acme/ces");
    const empty = remove("ces");
    assert.equal(empty.status, 0, empty.stderr);
    const card = check(
      CardSchema,
      await main.call("card.new", { title: "Keep history", kind: "ship", project: "meta-cx" }),
    );
    const refused = remove("meta-cx");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /project meta-cx has open cards: c-1/);
    const registered = check(OPS.projects.result, await main.call("projects", {}));
    assert.deepEqual(
      registered.map(({ name }) => name),
      ["meta-cx"],
    );
    await main.call("close.finish", {
      card: card.id,
      mode: "dropped",
      text: "Keep this history",
      archives: [],
      left: [],
    });
    const before = await cardd.thread(card.id);
    const removed = remove("meta-cx");
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(
      removed.stdout,
      /removed project and its clones.*Card history kept; no files deleted/,
    );
    const expected = { ...before, card: { ...before.card, revision: before.card.revision + 1 } };
    assert.deepEqual(await cardd.thread(card.id), expected);
    assert.equal((await cardd.board()).cards.find(({ id }) => id === card.id)?.project, "meta-cx");
    const projects = check(OPS.projects.result, await main.call("projects", {}));
    assert.deepEqual(projects, []);
    assert.equal(existsSync(join(scratch.root, "package.json")), true);
    const unknown = remove("meta-cx");
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /project meta-cx is not in the registry/);
    await assert.rejects(
      main.call("card.new", { title: "No longer tracked", kind: "ship", project: "meta-cx" }),
    );
    await cardd.restart();
    assert.deepEqual(await cardd.thread(card.id), expected);
  } finally {
    await cardd.stop();
    scratch.dispose();
  }
});

test("unclone updates project hosts and refresh plans without deleting files, and guards open work", async () => {
  const scratch = new Scratch();
  const cardd = await Cardd.start();
  const cli = (...args: string[]) =>
    spawnSync(
      "node",
      [join(scratch.root, "packages/cardd/src/main.ts"), ...args, "--db", cardd.db],
      {
        encoding: "utf8",
      },
    );
  const unclone = (host: string, project = "web") => cli("project", "unclone", project, host);
  try {
    const token = cardd.addLane("main");
    const main = await cardd.connect(token);
    cardd.addProject("web", { maverick: scratch.root, p620: scratch.root }, "acme/web");
    const removed = unclone("maverick");
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /removed clone on maverick/);
    assert.equal(existsSync(join(scratch.root, "package.json")), true);
    const listed = check(OPS.projects.result, await main.call("projects", {}));
    assert.deepEqual(listed[0]?.clones, [{ host: "p620", path: scratch.root }]);
    const card = check(
      CardSchema,
      await main.call("card.new", { title: "Work", kind: "ship", project: "web" }),
    );
    const closing = check(
      OPS["close.begin"].result,
      await main.call("close.begin", { card: card.id, landed: false }),
    );
    assert.deepEqual(closing.refresh, [
      { project: "web", host: "p620", path: scratch.root, base: "main" },
    ]);
    await assert.rejects(
      main.call("attempt.begin", { card: card.id, host: "maverick", task: "work" }),
      /has no clone on maverick/,
    );
    const last = unclone("p620");
    assert.notEqual(last.status, 0);
    assert.match(last.stderr, /last clone.*open cards.*c-1/);
    assert.equal(cli("project", "clone", "web", `maverick=${scratch.root}`).status, 0);
    await main.call("attempt.begin", { card: card.id, host: "maverick", task: "work" });
    const starting = unclone("maverick");
    assert.notEqual(starting.status, 0);
    assert.match(starting.stderr, /open attempts on maverick.*c-1/);
    const begun = check(
      OPS["attempt.begin"].result,
      await main.call("attempt.begin", { card: card.id, host: "maverick", task: "work" }),
    );
    await cardd.connect(begun.token);
    const active = unclone("maverick");
    assert.notEqual(active.status, 0);
    assert.match(active.stderr, /open attempts on maverick.*c-1/);
    await main.call("close.finish", {
      card: card.id,
      mode: "dropped",
      text: "Done",
      archives: [],
      left: [],
    });
    assert.equal(unclone("maverick").status, 0);
    const empty = unclone("p620");
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /last clone removed.*no open cards/);
    const final = check(OPS.projects.result, await main.call("projects", {}));
    assert.deepEqual(final[0]?.clones, []);
    const missing = unclone("p620");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /project web has no clone on p620/);
    const unknown = unclone("p620", "unknown");
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /project unknown is not in the registry/);
  } finally {
    await cardd.stop();
    scratch.dispose();
  }
});
