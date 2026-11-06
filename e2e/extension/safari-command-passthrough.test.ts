import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";
import { Scratch } from "../support/scratch.ts";

const CAPTURE = fileURLToPath(new URL("../support/capture-tool.ts", import.meta.url));
const SAFARI_TELL = `tell application "Safari" to activate`;
const NOTIFY = `display notification "done" with title "fleet"`;
const TARGET = "http://127.0.0.1:41000/?t=token";
const LONG_TEXT = ":;".repeat(50_000);

const SAFARI_COMMANDS: readonly string[] = [
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

beforeEach(async () => {
  scratch = new Scratch();
  fleet = await startFleet({});
  h = await Harness.start();
});
afterEach(async () => {
  const stopped = await Promise.allSettled([h.stop(), fleet.cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

for (const tool of ["bash", "run_long"]) {
  test(`a mate passes Safari commands, including remote paths, through ${tool}`, async () => {
    const captured = join(h.dir, "captured");
    const commands = [...SAFARI_COMMANDS, ...ALLOWED, `${LONG_TEXT}echo done`];
    for (const command of commands) h.onModel(() => ({ tool, args: { command } }));
    h.onModel(() => ({ text: "done" }));
    const mate = h.startPi(
      "main-mate",
      {
        FLEET_URL: fleet.cardd.url,
        FLEET_TOKEN: fleet.mainToken,
        FLEET_ROLE: "mate",
        FLEET_CAPTURE_FILE: captured,
      },
      [join(scratch.root, "packages/extension/src/index.ts"), CAPTURE],
    );
    await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
    mate.prompt("run the commands");
    await h.waitForCall(commands.length, "default", 60_000);
    assert.equal(
      readFileSync(captured, "utf8"),
      commands.map((command) => `${JSON.stringify(command)}\n`).join(""),
    );
  });
}
