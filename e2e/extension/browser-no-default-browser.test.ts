import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { spawnGuarded } from "../support/guarded.ts";
import { Scratch, configureMain } from "../support/scratch.ts";
import { until } from "../support/browser-herdr.ts";

const DEFAULT_BROWSERS = ["open", "xdg-open", "osascript", "safaridriver"];
const NOT_OPENED = "No browser was opened: Sheprd is not available here";

interface Run {
  readonly said: () => string;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

async function viewer(
  scratch: Scratch,
  home: string,
  flags: readonly string[],
  asked: string,
): Promise<Run> {
  const bin = join(scratch.parent, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of DEFAULT_BROWSERS) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${asked}'\n`, { mode: 0o755 });
  }
  const child = spawnGuarded(
    "node",
    [
      join(scratch.root, "packages/extension/src/browser-view.ts"),
      "--home",
      scratch.root,
      ...flags,
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        FLEET_BROWSER_VIEW_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const url = await until("the viewer address", () =>
    Promise.resolve(/Fleet browser viewer \((?:captain|gated)\): (\S+)/.exec(output)?.[1]),
  );
  return {
    said: () => output,
    url,
    stop: async () => {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    },
  };
}

const MODES: readonly (readonly string[])[] = [["--captain", "--open"], ["--open"]];

for (const flags of MODES) {
  const mode = flags.includes("--captain") ? "captain's" : "gated";

  test(`a ${mode} viewer with Sheprd installed opens Sheprd's tab and no default browser`, async () => {
    const scratch = new Scratch();
    const home = join(scratch.parent, "home");
    const bin = join(home, ".local/state/herdr/gpui/bin");
    const record = join(scratch.parent, "sheprd-opened");
    const asked = join(scratch.parent, "default-browser-asked");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "sheprd"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`, {
      mode: 0o755,
    });
    configureMain(scratch, "ws://127.0.0.1:1/session", "scratch-token");
    const run = await viewer(scratch, home, flags, asked);
    try {
      await until("Sheprd's open request", () =>
        Promise.resolve(existsSync(record) ? true : undefined),
      );
      assert.deepEqual(readFileSync(record, "utf8").trim().split("\n"), [
        "browser",
        "open",
        "--tab",
        run.url,
      ]);
      assert.equal(run.said().includes(NOT_OPENED), false);
      assert.equal(existsSync(asked), false);
    } finally {
      await run.stop();
      scratch.dispose();
    }
  });

  test(`a ${mode} viewer without Sheprd opens no browser and leaves its address in the tab`, async () => {
    const scratch = new Scratch();
    const home = join(scratch.parent, "home");
    const asked = join(scratch.parent, "default-browser-asked");
    mkdirSync(home, { recursive: true });
    configureMain(scratch, "ws://127.0.0.1:1/session", "scratch-token");
    const run = await viewer(scratch, home, flags, asked);
    try {
      await until("the viewer to settle how it was opened", () =>
        Promise.resolve(run.said().includes(NOT_OPENED) || existsSync(asked) ? true : undefined),
      );
      assert.equal(
        existsSync(asked) ? readFileSync(asked, "utf8") : "",
        "",
        "the viewer asked a default browser to open",
      );
      assert.ok(run.said().includes(NOT_OPENED), run.said());
      assert.ok((new URL(run.url).searchParams.get("t") ?? "").length >= 32);
    } finally {
      await run.stop();
      scratch.dispose();
    }
  });
}
