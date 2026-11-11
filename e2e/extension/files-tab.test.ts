import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { FilesMates, until } from "../support/files-mates.ts";

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

async function startedWithFiles(): Promise<{ workspace: string; pane: string }> {
  mates.up();
  const workspace = await until("the mate's workspace", mateSpace);
  const pane = await until("the Files tab", () => mates.filesPane(workspace));
  return { workspace, pane };
}

test("a mate's workspace gets a Files tab that runs the explorer in the lane home", async () => {
  const { workspace, pane } = await startedWithFiles();
  await until("the explorer", async () =>
    (await mates.lab.screen(pane)).includes(`FILES-TAB-STUB in ${mates.fleet.home}`)
      ? true
      : undefined,
  );
  const labels = await tabLabels(workspace);
  assert.equal(labels.length, 2);
  assert.equal(labels[1], "Files");
});

test("a reload of the mate and a second fleet up leave one Files tab, and its running explorer alone", async () => {
  const { workspace, pane } = await startedWithFiles();
  await until("the explorer", async () =>
    (await mates.lab.screen(pane)).includes("FILES-TAB-STUB") ? true : undefined,
  );
  const mate = String(
    (await mates.lab.run(["pane", "list", "--workspace", workspace]))["panes"] === undefined
      ? ""
      : "w1:p1",
  );
  await mates.lab.submit(mate, "/reload");
  mates.up();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.deepEqual(await tabLabels(workspace), ["1", "Files"]);
  const screen = await mates.lab.screen(pane);
  assert.equal(screen.split("FILES-TAB-STUB").length - 1, 1);
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
