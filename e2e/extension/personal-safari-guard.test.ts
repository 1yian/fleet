import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Pi } from "../support/harness.ts";
import { Scratch } from "../support/scratch.ts";

const SHELL = fileURLToPath(new URL("../support/shell-tool.ts", import.meta.url));
const CAPTURE = fileURLToPath(new URL("../support/capture-tool.ts", import.meta.url));
const refusals = (text: string): number =>
  text.match(/refused: Safari on the captain's Mac/g)?.length ?? 0;
const STUBBED = [
  "osascript",
  "open",
  "ssh",
  "mosh",
  "tailscale",
  "safaridriver",
  "sheprd",
  "xdg-open",
];

const SAFARI_TELL = `tell application "Safari" to activate`;
const NOTIFY = `display notification "done" with title "fleet"`;
const TARGET = "http://127.0.0.1:41000/?t=token";
const LONG_TEXT = ":;".repeat(50_000);

const REFUSED: readonly string[] = [
  `osascript -e '${SAFARI_TELL}'`,
  `osascript -e 'tell application "Safari"' -e 'open location "https://example.com"' -e 'end tell'`,
  `osascript -e 'tell application id "com.apple.Safari" to activate'`,
  `osascript -l JavaScript -e 'Application("safari").activate()'`,
  `/usr/bin/osascript -e '${SAFARI_TELL}'`,
  `osascript <<'EOF'\n${SAFARI_TELL}\nEOF`,
  `cd /tmp && osascript -e '${SAFARI_TELL}'`,
  `FOO=1 sudo osascript -e '${SAFARI_TELL}'`,
  `bash -c "osascript -e '${SAFARI_TELL}'"`,
  `sh -lc 'open -a Safari https://example.com'`,
  `eval "open -a Safari https://example.com"`,
  `open -a Safari https://example.com`,
  `open -a "Safari" https://example.com`,
  `open -b com.apple.Safari https://example.com`,
  `/usr/bin/open -a safari https://example.com`,
  `open /Applications/Safari.app`,
  `echo go; open -a 'Safari Technology Preview' https://example.com`,
  `safaridriver -p 4444`,
  `ssh frontera osascript -e '${SAFARI_TELL}'`,
  `ssh yian@frontera.local "open -a Safari https://example.com"`,
  `ssh -t frontera "osascript -e 'tell application \\"Safari\\" to activate'"`,
  `ssh -o ConnectTimeout=5 100.64.0.7 'safaridriver --enable'`,
  `tailscale ssh yian@frontera open -a Safari https://example.com`,
  `ssh -p 22 frontera osascript -e '${SAFARI_TELL}'`,
  `ssh -l yian -i /tmp/key -o ConnectTimeout=5 frontera "open -a Safari https://example.com"`,
  `ssh -o ConnectTimeout=5 frontera 'cd /tmp && open -a Safari https://example.com'`,
  `ssh frontera 'sudo open -a Safari https://example.com'`,
  String.raw`ssh frontera "bash -c 'osascript -e \"tell application \\\"Safari\\\" to activate\"'"`,
  `ssh -p 22 frontera safaridriver --enable`,
  `mosh frontera -- open -a Safari https://example.com`,
  `mosh --ssh="ssh -p 22" frontera -- osascript -e '${SAFARI_TELL}'`,
  `tailscale ssh yian@frontera osascript -e '${SAFARI_TELL}'`,
  `for u in a b; do open -a Safari https://example.com; done`,
  `while read u; do open -a Safari "$u"; done`,
  `until false; do open -a Safari https://example.com; done`,
  `if true; then osascript -e '${SAFARI_TELL}'; fi`,
  `if open -a Safari https://example.com; then echo ok; fi`,
  `if false; then echo no; elif true; then open -a Safari https://example.com; fi`,
  `if false; then echo no; else open -a Safari https://example.com; fi`,
  `if true; then safaridriver --enable; fi`,
  `{ open -a Safari https://example.com; }`,
  `! open -a Safari https://example.com`,
  `ssh frontera 'for u in a b; do open -a Safari https://example.com; done'`,
  `ssh frontera 'if true; then safaridriver --enable; fi'`,
  `ssh frontera '{ open -a Safari https://example.com; }'`,
  `${LONG_TEXT}; open -a Safari https://example.com`,
];

const ALLOWED: readonly string[] = [
  `osascript -e '${NOTIFY}'`,
  `osascript <<'EOF'\n${NOTIFY}\nEOF`,
  `ssh frontera uptime`,
  `ssh frontera osascript -e '${NOTIFY}'`,
  `sheprd browser open --tab ${TARGET}`,
  `ssh frontera sheprd browser open --tab ${TARGET}`,
  `echo "the guard refuses osascript commands that name Safari"`,
  `ssh frontera sheprd browser open --tab http://127.0.0.1:41000/?t=Safari`,
  `ssh -p 22 frontera sheprd browser open --tab https://example.com/Safari`,
  `ssh frontera 'echo safaridriver'`,
  `ssh frontera "echo open -a Safari"`,
  `mosh frontera -- sheprd browser open --tab https://example.com/Safari`,
  `tailscale ssh yian@frontera sheprd browser open --tab https://example.com/Safari`,
  `if true; then osascript -e '${NOTIFY}'; fi`,
  `for u in a b; do echo open -a Safari; done`,
  `ssh frontera 'if true; then echo safaridriver; fi'`,
];

let fleet: Fleet;
let h: Harness;
let scratch: Scratch;
let ran: string;
let captured: string;

beforeEach(async () => {
  scratch = new Scratch();
  fleet = await startFleet({});
  h = await Harness.start();
  ran = join(h.dir, "ran");
  captured = join(h.dir, "captured");
});
afterEach(async () => {
  const stopped = await Promise.allSettled([h.stop(), fleet.cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

function stubPrograms(): string {
  const bin = join(h.dir, "bin");
  mkdirSync(bin);
  for (const name of STUBBED) {
    const file = join(bin, name);
    writeFileSync(
      file,
      `#!/bin/sh\n{ printf '%s' '${name}'; for a in "$@"; do printf ' %s' "$a"; done; echo; } >> '${ran}'\n`,
    );
    chmodSync(file, 0o755);
  }
  return bin;
}

function startMate(tool: string, env: Record<string, string>): Pi {
  return h.startPi(
    "main-mate",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: fleet.mainToken,
      FLEET_ROLE: "mate",
      ...env,
    },
    [join(scratch.root, "packages/extension/src/index.ts"), tool],
  );
}

async function runAll(
  commands: readonly string[],
  tool: string,
  env: Record<string, string>,
): Promise<string> {
  for (const command of commands) h.onModel(() => ({ tool: "bash", args: { command } }));
  h.onModel(() => ({ text: "done" }));
  const mate = startMate(tool, env);
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("run the commands");
  const turns = await h.waitForCall(commands.length, "default", 60_000);
  return turns
    .filter((turn) => turn.role === "toolResult")
    .map((turn) => turn.text)
    .join("\n");
}

test("a mate is refused every recognizable command that drives Safari on the captain's Mac", async () => {
  const told = await runAll(REFUSED, CAPTURE, { FLEET_CAPTURE_FILE: captured });
  assert.equal(refusals(told), REFUSED.length, told);
  assert.equal(
    existsSync(captured),
    false,
    existsSync(captured) ? readFileSync(captured, "utf8") : "",
  );
});

test("a mate still runs osascript that names no Safari, ssh, text about Safari, and the Sheprd browser path", async () => {
  const bin = stubPrograms();
  const told = await runAll(ALLOWED, SHELL, { PATH: `${bin}:${process.env["PATH"] ?? ""}` });
  assert.equal(refusals(told), 0, told);
  assert.deepEqual(readFileSync(ran, "utf8").trim().split("\n"), [
    `osascript -e ${NOTIFY}`,
    "osascript",
    "ssh frontera uptime",
    `ssh frontera osascript -e ${NOTIFY}`,
    `sheprd browser open --tab ${TARGET}`,
    `ssh frontera sheprd browser open --tab ${TARGET}`,
    "ssh frontera sheprd browser open --tab http://127.0.0.1:41000/?t=Safari",
    "ssh -p 22 frontera sheprd browser open --tab https://example.com/Safari",
    "ssh frontera echo safaridriver",
    "ssh frontera echo open -a Safari",
    "mosh frontera -- sheprd browser open --tab https://example.com/Safari",
    "tailscale ssh yian@frontera sheprd browser open --tab https://example.com/Safari",
    `osascript -e ${NOTIFY}`,
    "ssh frontera if true; then echo safaridriver; fi",
  ]);
});

test("a mate still runs a 100 KB command that names no Safari", async () => {
  const told = await runAll([`${LONG_TEXT}echo done`], SHELL, {});
  assert.equal(refusals(told), 0, told);
  assert.equal(told, "done\nexit 0");
});
