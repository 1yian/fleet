import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  toolResults,
  WORKER_WAIT_MS,
  workersOf,
  type DispatchLab,
  type LabOptions,
} from "../support/dispatch-lab.ts";

const COMMAND = `#!/bin/sh
printf '%s\\n' "$*" >> "$0.log"
if [ "$1" = register ] && [ -f "$0.refuse" ]; then
  echo "the CNP root has no config" >&2
  exit 1
fi
if [ "$1" = release ] && [ -f "$0.refuse-release" ]; then
  echo "direnv blocks the CNP folder" >&2
  exit 1
fi
`;

let parts: DispatchLab | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (parts !== undefined) await stopDispatchLab(parts);
  parts = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function lab(options: LabOptions = {}): Promise<{ p: DispatchLab; command: string }> {
  dir = mkdtempSync(join(tmpdir(), "fleet-nm-command-"));
  const command = join(dir, "no-mistakes-cnp");
  writeFileSync(command, COMMAND);
  chmodSync(command, 0o755);
  parts = await startDispatchLab({ ...options, mate: { FLEET_NO_MISTAKES: command } });
  return { p: parts, command };
}

const calls = (command: string): string[] =>
  existsSync(`${command}.log`) ? readFileSync(`${command}.log`, "utf8").trim().split("\n") : [];

const CARD_NEW = {
  tool: "card_new",
  args: { title: "Add credit", name: "add-credit", kind: "ship", project: "site" },
} as const;
const DISPATCH = {
  tool: "dispatch",
  args: { card: 1, host: "local", task: "add the credit" },
} as const;
const CLOSE = {
  tool: "close",
  args: { card: 1, summary: "the design changed", landed: false },
} as const;

function scriptMate(
  p: DispatchLab,
  ...moves: (typeof CARD_NEW | typeof DISPATCH | typeof CLOSE | string)[]
) {
  for (const move of moves)
    p.h.onModel(() => (typeof move === "string" ? { text: move } : move), "mate");
}

test("a no-mistakes card on a lane with a CNP command registers its clone at dispatch, tells the worker the command, and releases the clone when the card closes", async () => {
  const { p, command } = await lab();
  p.h.onModel(
    () => ({ tool: "report", args: { status: "blocked", text: "the design is unclear" } }),
    "worker",
  );
  scriptMate(p, CARD_NEW, DISPATCH, "dispatched", CLOSE, "closed");
  await mateConnected(p.h);
  p.mate.prompt("add the credit");

  const first = await p.h.waitForCall(0, "worker", WORKER_WAIT_MS);
  assert.equal(
    lastUser(first),
    `[fleet] main on c-1 add-credit: add the credit\n\nNo-mistakes command: ${command}\n\nDelivery: no-mistakes`,
  );
  const closed = toolResults(await p.h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1);
  assert.match(closed ?? "", /^c-1 is dropped\./);
  assert.deepEqual(calls(command), [`register ${p.clone} c-1`, `release ${p.clone} c-1`]);
  assert.deepEqual(await workersOf(p.lab), []);
});

test("a registration that fails stops the dispatch before any worker starts, and a retry after the fix starts it", async () => {
  const { p, command } = await lab();
  writeFileSync(`${command}.refuse`, "");
  p.h.onModel(
    () => ({ tool: "report", args: { status: "blocked", text: "the design is unclear" } }),
    "worker",
  );
  scriptMate(p, CARD_NEW, DISPATCH, "not started", DISPATCH, "started", "woken");
  await mateConnected(p.h);
  p.mate.prompt("add the credit");

  const refused = toolResults(await p.h.waitForCall(2, "mate", WORKER_WAIT_MS)).at(-1);
  assert.match(
    refused ?? "",
    /c-1 was not started: .* could not be registered with .*: .*the CNP root has no config/,
  );
  assert.deepEqual(await workersOf(p.lab), []);
  rmSync(`${command}.refuse`);
  p.mate.prompt("try again");
  const started = toolResults(await p.h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1);
  assert.equal(started, "Dispatched c-1-a1 on local, branch c-1-a1.");
  assert.deepEqual(calls(command), [`register ${p.clone} c-1`, `register ${p.clone} c-1`]);
});

test("a release that fails does not keep the card open, and the close says what is still registered", async () => {
  const { p, command } = await lab();
  writeFileSync(`${command}.refuse-release`, "");
  p.h.onModel(
    () => ({ tool: "report", args: { status: "blocked", text: "the design is unclear" } }),
    "worker",
  );
  scriptMate(p, CARD_NEW, DISPATCH, "dispatched", CLOSE, "closed");
  await mateConnected(p.h);
  p.mate.prompt("add the credit");

  const closed = toolResults(await p.h.waitForCall(4, "mate", WORKER_WAIT_MS)).at(-1) ?? "";
  assert.match(closed, /^c-1 is dropped\./);
  assert.match(closed, /Still registered with .* for c-1: .* \(.*direnv blocks the CNP folder\)\./);
});

test("a card that is not delivered through no-mistakes registers nothing, but its lane's command still reaches the worker", async () => {
  const { p, command } = await lab({ delivery: "direct-PR" });
  p.h.onModel(
    () => ({ tool: "report", args: { status: "blocked", text: "the design is unclear" } }),
    "worker",
  );
  scriptMate(p, CARD_NEW, DISPATCH, "dispatched");
  await mateConnected(p.h);
  p.mate.prompt("add the credit");

  const first = await p.h.waitForCall(0, "worker", WORKER_WAIT_MS);
  assert.match(lastUser(first) ?? "", /\n\nDelivery: direct-PR$/);
  assert.deepEqual(calls(command), []);
});
