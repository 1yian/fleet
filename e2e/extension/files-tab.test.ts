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

async function reloadMate(): Promise<void> {
  const before = await until("the mate's skills record", skillsRecordedAt);
  await mates.lab.submit(await mates.matePane(), "/reload");
  mates.up();
  await until("the reloaded mate's new skills record", () => {
    const now = skillsRecordedAt();
    return now !== undefined && now !== before ? now : undefined;
  });
}

const running = (pane: string, name: string): Promise<string[]> =>
  until(`${name} in ${pane}`, async () => {
    const processes = await mates.lab.foreground(pane);
    return processes.some((each) => each.endsWith(`:${name}`)) ? processes : undefined;
  });

const atPrompt = (pane: string): Promise<string[]> =>
  until(`a shell prompt in ${pane}`, async () => {
    const processes = await mates.lab.foreground(pane);
    return processes.length === 1 && /:(ba|z|fi)?sh$/.test(processes[0] ?? "")
      ? processes
      : undefined;
  });

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
  const explorer = await running(pane, "yazi");
  await reloadMate();
  assert.deepEqual(await tabLabels(workspace), ["1", "Files"]);
  assert.deepEqual(await mates.lab.foreground(pane), explorer);
  assert.match(await files.screen(), header(data));
});

test("a Files tab whose explorer has quit gets the explorer again in the same pane, from wherever its shell stands", async () => {
  const { workspace, pane } = await startedWithFiles();
  const files = FilesPane.attach(mates.lab, pane);
  await running(pane, "yazi");
  await files.sees("AGENTS.md");
  await files.type("q");
  await atPrompt(pane);
  await mates.lab.submit(pane, "cd /");
  await reloadMate();
  await running(pane, "yazi");
  await files.sees(header(mates.fleet.home), "yazi's header to name the lane home");
  await files.sees("AGENTS.md");
  assert.equal(await mates.filesPane(workspace), pane);
  assert.deepEqual(await tabLabels(workspace), ["1", "Files"]);
});

test("a Files pane that runs another program is left alone, whether its shell runs it or became it", async () => {
  const { pane } = await startedWithFiles();
  const files = FilesPane.attach(mates.lab, pane);
  await running(pane, "yazi");
  await files.sees("AGENTS.md");
  await files.type("q");
  await atPrompt(pane);
  await mates.lab.submit(pane, "sleep 3000");
  const child = await running(pane, "sleep");
  const childScreen = await files.screen();
  await reloadMate();
  assert.deepEqual(await mates.lab.foreground(pane), child);
  assert.equal(await files.screen(), childScreen);
  await mates.lab.press(pane, "ctrl+c");
  await atPrompt(pane);
  await mates.lab.submit(pane, "exec sleep 3000");
  const became = await running(pane, "sleep");
  const becameScreen = await files.screen();
  await reloadMate();
  assert.deepEqual(await mates.lab.foreground(pane), became);
  assert.equal(await files.screen(), becameScreen);
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
