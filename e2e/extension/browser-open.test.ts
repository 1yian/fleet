import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { spawnGuarded } from "../support/guarded.ts";
import { Scratch, configureMain } from "../support/scratch.ts";
import { until } from "../support/browser-herdr.ts";

const DEFAULT_BROWSERS = ["open", "xdg-open", "osascript", "safaridriver"];

interface Run {
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
    url,
    stop: async () => {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    },
  };
}

for (const captain of [true, false]) {
  for (const shim of ["installed", "absent", "failed"]) {
    test(`a ${captain ? "captain's" : "gated"} viewer opens with Sheprd ${shim}`, async () => {
      const scratch = new Scratch();
      const home = join(scratch.parent, "home");
      const bin = join(home, ".local/state/herdr/gpui/bin");
      const record = join(scratch.parent, "sheprd-opened");
      const asked = join(scratch.parent, "default-browser-asked");
      mkdirSync(bin, { recursive: true });
      if (shim !== "absent") {
        writeFileSync(
          join(bin, "sheprd"),
          `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\nexit ${shim === "failed" ? "1" : "0"}\n`,
          { mode: 0o755 },
        );
      }
      configureMain(scratch, "ws://127.0.0.1:1/session", "scratch-token");
      const flags = captain ? ["--captain", "--open"] : ["--open"];
      const run = await viewer(scratch, home, flags, asked);
      try {
        const sheprd = captain && shim === "installed";
        await until("the browser open request", () =>
          Promise.resolve(existsSync(sheprd ? record : asked) ? true : undefined),
        );
        if (captain && shim !== "absent") {
          assert.deepEqual(readFileSync(record, "utf8").trim().split("\n"), [
            "browser",
            "open",
            "--tab",
            run.url,
          ]);
        } else {
          assert.equal(existsSync(record), false);
        }
        if (sheprd) {
          assert.equal(existsSync(asked), false);
        } else {
          const opener = process.platform === "darwin" ? "open" : "xdg-open";
          assert.equal(readFileSync(asked, "utf8"), `${opener} ${run.url}\n`);
        }
        assert.ok((new URL(run.url).searchParams.get("t") ?? "").length >= 32);
      } finally {
        await run.stop();
        scratch.dispose();
      }
    });
  }
}
