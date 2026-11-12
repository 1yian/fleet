import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FilesMates, until } from "../support/files-mates.ts";
import { FilesPane } from "../support/files-pane.ts";
import { optionalString, parseRecord } from "../support/json.ts";

let mates: FilesMates;
beforeEach(async () => {
  mates = await FilesMates.start();
});
afterEach(async (t) => {
  await mates.lab.printIfFailed(t);
  await mates.stop();
});

const mateSpace = (): Promise<string | undefined> => mates.workspace(`2ndmate-${mates.lane}`);

async function tabLabels(workspace: string): Promise<string[]> {
  return (await mates.tabs(workspace)).map((tab) => String(tab["label"]));
}

function skillsRecordedAt(): string | undefined {
  try {
    const record = join(mates.fleet.home, "state", "skills.json");
    return optionalString(parseRecord(readFileSync(record, "utf8")), "at");
  } catch {
    return undefined;
  }
}

async function startedWithFiles(): Promise<{ workspace: string; pane: string }> {
  mates.up();
  const workspace = await until("the mate's workspace", mateSpace);
  const pane = await until("the Files tab", () => mates.filesPane(workspace));
  return { workspace, pane };
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const header = (folder: string): RegExp => new RegExp(`^${escaped(folder)}(\\s.*)?$`, "m");

test("a mate's workspace gets a Files tab that runs yazi in the lane home", async () => {
  const { workspace, pane } = await startedWithFiles();
  const files = FilesPane.attach(mates.lab, pane);
  await files.sees(header(mates.fleet.home), "yazi's header to name the lane home");
  await files.sees("AGENTS.md");
  const labels = await tabLabels(workspace);
  assert.equal(labels.length, 2);
  assert.equal(labels[1], "Files");
});

test("a reload of the mate and a second fleet up leave one Files tab, and its running explorer alone", async () => {
  const data = join(mates.fleet.home, "data");
  mkdirSync(data, { recursive: true });
  const { workspace, pane } = await startedWithFiles();
  const files = FilesPane.attach(mates.lab, pane);
  await files.sees("AGENTS.md");
  await files.type("gd");
  await files.sees(header(data), "the header to name data");
  const before = await until("the mate's first skills record", skillsRecordedAt);
  const mate = await mates.matePane();
  await mates.lab.submit(mate, "/reload");
  mates.up();
  await until("the reloaded mate's new skills record", () => {
    const now = skillsRecordedAt();
    return now !== undefined && now !== before ? now : undefined;
  });
  assert.deepEqual(await tabLabels(workspace), ["1", "Files"]);
  assert.match(await files.screen(), header(data));
});

test("the Files tab goes with its workspace, and a mate started again makes one new tab", async () => {
  const { workspace } = await startedWithFiles();
  await mates.lab.run(["workspace", "close", workspace]);
  assert.equal(await mateSpace(), undefined);
  mates.up();
  const again = await until("the new workspace", mateSpace);
  await until("the new Files tab", () => mates.filesPane(again));
  assert.deepEqual(await tabLabels(again), ["1", "Files"]);
});
