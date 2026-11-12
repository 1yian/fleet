import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CardSchema, check } from "@fleet/protocol";
import { FilesMates, until } from "../support/files-mates.ts";
import { FilesPane } from "../support/files-pane.ts";
import { tempDir } from "../support/run-root.ts";
import { mateArgs } from "../support/scratch.ts";

let mates: FilesMates | undefined;
afterEach(async (t) => {
  await mates?.lab.printIfFailed(t);
  await mates?.stop();
  mates = undefined;
});

const requireTools = (): void => {
  for (const tool of ["nvim", "fzf"]) execFileSync("sh", ["-c", `command -v ${tool}`]);
};

const sha12 = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);

async function explorer(m: FilesMates): Promise<FilesPane> {
  m.up();
  const workspace = await until("the mate's workspace", () => m.workspace(`2ndmate-${m.lane}`));
  const pane = await until("the Files tab", () => m.filesPane(workspace));
  const files = FilesPane.attach(m.lab, pane);
  await files.sees("AGENTS.md");
  await files.hover("AGENTS.md");
  return files;
}

const lastUserText = (m: FilesMates, agent: string): string =>
  m.h
    .callsOf(agent)
    .at(-1)
    ?.findLast((turn) => turn.role === "user")?.text ?? "";

async function typedInto(m: FilesMates, agent: string, text: RegExp): Promise<string> {
  return until(`a message to ${agent} that matches ${String(text)}`, () => {
    const found = m.h.callsOf(agent).findLast((turns) => text.test(turns.at(-1)?.text ?? ""));
    return found?.at(-1)?.text;
  });
}

test("S shows this lane's mate a file, typed as a message only after Enter, and Esc types nothing", async () => {
  requireTools();
  mates = await FilesMates.start({ files: { main: "p620" } });
  mates.h.onModel(() => ({ text: "noted" }), "mate");
  const files = await explorer(mates);
  const agents = join(mates.fleet.home, "AGENTS.md");

  await files.type("S");
  await files.sees(`sha256 ${sha12(agents)}.`);
  await files.press("esc");
  await files.sees(/^cancelled, nothing was typed/m, "the cancel result on a line of its own");
  assert.equal(mates.h.callsOf("mate").length, 0);
  await files.press("esc");
  await files.goneFrom("cancelled, nothing was typed");

  await files.type("S");
  await files.sees("Enter sends");
  await files.type("check the intro");
  await files.press("enter");
  await files.sees(
    /^typed into the pane of the cleo mate on p620/m,
    "the delivery result on a line of its own",
  );
  const text = await typedInto(mates, "mate", /Files tab on p620/);
  assert.equal(
    text,
    `From this lane's Files tab on p620: look at the file ${agents}, sha256 ${sha12(agents)}. check the intro`,
  );
  assert.equal(mates.h.callsOf("main").length, 0);
});

test("M types into main's pane when this host reaches main, with the lane named", async () => {
  requireTools();
  mates = await FilesMates.start({ files: { main: "p620" } });
  mates.h.onModel(() => ({ text: "noted" }), "main");
  mates.h.onModel(() => ({ text: "noted" }), "mate");
  const mainPane = await mates.mainPane();
  await until("main to be up", async () =>
    (await mates?.workspace("1stmate")) === undefined ? undefined : true,
  );
  assert.ok(mainPane !== "");
  const files = await explorer(mates);
  const agents = join(mates.fleet.home, "AGENTS.md");

  await files.type("M");
  await files.sees("Enter sends AGENTS.md to main");
  await files.press("enter");
  await files.sees("typed into the pane of the main mate on p620");
  const text = await typedInto(mates, "main", /Files tab on p620/);
  assert.equal(
    text,
    `From the cleo lane's Files tab on p620: look at the file ${agents}, sha256 ${sha12(agents)}.`,
  );
  assert.equal(mates.h.callsOf("mate").length, 0);
});

test("M with no way to reach main's herdr posts a board comment that main hears as the captain's", async () => {
  requireTools();
  mates = await FilesMates.start({ files: {} });
  mates.h.onModel(() => ({ text: "noted" }), "main");
  mates.h.onModel(() => ({ text: "noted" }), "mate");
  const lane = await mates.fleet.cardd.connect(mates.fleet.laneToken);
  const card = check(
    CardSchema,
    await lane.call("card.new", { title: "the lane's card", kind: "scout", project: "fleet" }),
  );
  await mates.mainPane();
  const files = await explorer(mates);

  await files.type("M");
  await files.press("enter");
  await files.sees("this lane does not say where main runs");
  await files.sees(`comment on c-${String(card.id)}`);
  const heard = await typedInto(mates, "main", /captain on c-\d+/);
  assert.match(heard, new RegExp(`\\[fleet\\] captain on c-${String(card.id)} .*cleo`));
  assert.match(heard, /From the cleo lane's Files tab on p620: look at the file /);
  await lane.close();
});

test("R is refused while the mate works, and when it is idle types /reload so the new skill is listed", async () => {
  requireTools();
  const folder = join(tempDir("files-skills-"), "skills");
  mkdirSync(folder, { recursive: true });
  mates = await FilesMates.start({
    laneArgs: (h) => [...mateArgs(h), "--skill", folder],
  });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  mates.h.onModel(async () => {
    await held;
    return { text: "done thinking" };
  }, "mate");
  const files = await explorer(mates);
  const matePane = await mates.matePane();
  await mates.lab.submit(matePane, "think about it");
  await until("the mate to work", async () => {
    const got = await mates?.lab.run(["pane", "get", matePane]);
    const pane = got?.["pane"];
    return typeof pane === "object" &&
      pane !== null &&
      Reflect.get(pane, "agent_status") === "working"
      ? true
      : undefined;
  });

  await files.type("R");
  await files.sees("is working, and Pi can only reload when it is idle. Nothing was typed");
  await files.press("esc");
  await files.goneFrom("Nothing was typed");

  mkdirSync(join(folder, "fresh"), { recursive: true });
  writeFileSync(
    join(folder, "fresh", "SKILL.md"),
    "---\nname: fresh\ndescription: a fresh skill\n---\nbody\n",
  );
  release();
  await until("the mate to be idle", async () => {
    const got = await mates?.lab.run(["pane", "get", matePane]);
    const pane = got?.["pane"];
    return typeof pane === "object" && pane !== null && Reflect.get(pane, "agent_status") === "idle"
      ? true
      : undefined;
  });
  await files.type("R");
  await files.sees("Enter types /reload");
  await files.press("enter");
  await files.sees("typed into the pane of the cleo mate on p620");
  const record = join(mates.fleet.home, "state", "skills.json");
  await until("the new skill in the mate's record", () =>
    readFileSync(record, "utf8").includes('"fresh"') ? true : undefined,
  );
  assert.equal(lastUserText(mates, "mate"), "think about it");
});

test("R is refused when the mate started working while its prompt was open, and types nothing", async () => {
  requireTools();
  mates = await FilesMates.start();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  mates.h.onModel(async () => {
    await held;
    return { text: "done thinking" };
  }, "mate");
  const files = await explorer(mates);
  const matePane = await mates.matePane();

  await files.type("R");
  await files.sees("Enter types /reload");
  await mates.lab.submit(matePane, "think about it");
  await until("the mate to work", async () => {
    const got = await mates?.lab.run(["pane", "get", matePane]);
    const pane = got?.["pane"];
    return typeof pane === "object" &&
      pane !== null &&
      Reflect.get(pane, "agent_status") === "working"
      ? true
      : undefined;
  });
  await files.press("enter");
  await files.sees(
    /^the cleo mate is working, and Pi can only reload when it is idle\. Nothing was typed/m,
    "the refusal on a line of its own",
  );
  release();
  assert.equal(lastUserText(mates, "mate"), "think about it");
});
