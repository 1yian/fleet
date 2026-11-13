import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CardSchema, check } from "@fleet/protocol";
import { DecideLab, awaiting, onCard, rowsOf, SHIP, showing, keep } from "../support/decide-lab.ts";
import { FakeElement } from "../support/fake-element.ts";
import { FakeOpener } from "../support/fake-opener.ts";
import { ageCard } from "../support/fleet.ts";
import { HerdrClient, type Cell } from "../support/herdr-client.ts";
import { HerdrLab } from "../support/herdr.ts";
import { SshLab } from "../support/ssh-lab.ts";

let lab: DecideLab;
let ssh: SshLab;
let local: HerdrLab;
let client: HerdrClient | undefined;
beforeEach(async () => {
  lab = await DecideLab.start();
  ssh = new SshLab();
  await ssh.start();
  local = await HerdrLab.start({});
  writeFileSync(local.config, "onboarding = false\n[remote]\nmanage_ssh_config = false\n");
  const agent = lab.h.piEnv("mate")["PI_CODING_AGENT_DIR"];
  assert.ok(agent !== undefined);
  const extensions = join(agent, "extensions");
  mkdirSync(extensions, { recursive: true });
  copyFileSync(
    process.env["FLEET_E2E_STATUS_FOOTER"] ??
      fileURLToPath(new URL("../support/status-footer.ts", import.meta.url)),
    join(extensions, "statusline.ts"),
  );
});
afterEach(async (t) => {
  client?.stop();
  client = undefined;
  keep("custom-footer-ssh", ssh.evidence());
  await ssh.stop();
  await local.stop();
  await lab.stop(t);
});

function cellOf(screen: string, text: string): Cell {
  const rows = rowsOf(screen);
  const row = rows.findLastIndex((line) => line.includes(text));
  assert.ok(row >= 0, `${text} is absent:\n${screen}`);
  return { row, column: (rows[row]?.lastIndexOf(text) ?? 0) + 1 };
}

const LAYOUTS = [
  { columns: 194, hyperlinks: "0" },
  { columns: 100, hyperlinks: "0" },
  { columns: 194, hyperlinks: "1" },
] as const;

for (const { columns, hyperlinks } of LAYOUTS) {
  test(`plain clicks reach the custom footer over SSH in a WezTerm client at ${String(columns)} columns with hyperlinks ${hyperlinks}`, async () => {
    const host = new FakeOpener();
    const browser = new FakeElement();
    const pi = process.env["FLEET_E2E_PI"];
    if (pi !== undefined) symlinkSync(pi, join(host.dir, "pi"));
    const pane = await lab.openMain({
      PI_HYPERLINKS: hyperlinks,
      PROBE_MOUSE: "1",
      PATH: host.dir,
      ELEMENT_HOME: browser.home,
      FLEET_PANE_POLL_MS: "400",
      ...(process.env["FLEET_E2E_HERDR_SERVER"] === undefined
        ? {}
        : { FLEET_E2E_HERDR_SERVER: process.env["FLEET_E2E_HERDR_SERVER"] }),
    });
    await lab.askedMain(pane, "Scrollbar fix", SHIP, ["Ship it", "Hold"], 1);
    await lab.failedWorker("Fix the build");
    const idle = check(
      CardSchema,
      await lab.cleo.call("card.new", { title: "Read the invoices", kind: "scout" }),
    );
    ageCard(lab.cardd, idle, 5 * 3_600_000);
    await lab.screenWhere(pane, "all custom footer counts", showing(["1 stalled card"]));
    client = await HerdrClient.start(
      lab.herdr(),
      pane,
      { PATH: ssh.bin },
      { rows: 36, columns },
      { target: "fleet-click-lab", local },
    );
    const before = await lab.screenWhere(
      pane,
      "the custom footer after SSH attach",
      showing(["board"]),
    );
    keep(`custom-footer-${String(columns)}-before`, before);

    const decision = cellOf(before, awaiting(1));
    await client.click(pane, decision);
    const mouse = await lab.h.waitFor(
      (event) => event["type"] === "terminal_mouse",
      "a mouse report at Pi",
    );
    assert.deepEqual(mouse["data"], {
      button: 0,
      x: decision.column - 1,
      y: decision.row,
      release: false,
    });
    keep(`custom-footer-${String(columns)}-mouse`, JSON.stringify(mouse));
    keep(
      `custom-footer-${String(columns)}-decision`,
      await lab.screenWhere(pane, "the clicked decision", onCard([SHIP, "Decision 1 of 1"])),
    );
    await lab.herdr().press(pane, "esc");
    for (const [text, title] of [
      ["1 broken card", "Fix the build"],
      ["1 stalled card", "Read the invoices"],
    ]) {
      const screen = await lab.screenWhere(pane, text ?? "count", showing([text ?? ""]));
      assert.ok(text !== undefined && title !== undefined);
      await client.click(pane, cellOf(screen, text));
      keep(
        `custom-footer-${String(columns)}-${text.replaceAll(" ", "-")}`,
        await lab.screenWhere(pane, "the clicked card list", showing([title, "╭─"])),
      );
      await lab.herdr().press(pane, "esc");
    }
    const screen = await lab.screenWhere(pane, "the board link", showing(["board"], ["╭─"]));
    browser.exitCode = 1;
    await client.click(pane, cellOf(screen, "board"));
    await lab.screenWhere(
      pane,
      "the missing browser instruction",
      showing(["Could not open", "browser extension", "click again"]),
    );
    assert.deepEqual(
      host.opened(),
      [],
      "a disconnected browser must not fall back to the pane host",
    );
    browser.exitCode = 0;
    const retry = cellOf(await lab.herdr().screen(pane), "board");
    await client.click(pane, { row: retry.row + 1, column: 2 });
    await client.click(pane, retry);
    const deadline = Date.now() + 10_000;
    while (browser.opened().length < 2) {
      assert.ok(Date.now() < deadline, "the client browser never opened");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(browser.opened(), [
      lab.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"),
      lab.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"),
    ]);
    assert.deepEqual(host.opened(), [], "no URL is opened on the pane host");
    assert.match(ssh.evidence(), /Starting session: command/);
  });
}
