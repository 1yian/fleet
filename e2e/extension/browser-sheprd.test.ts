import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { spawnGuarded } from "../support/guarded.ts";
import { Scratch, configureMain } from "../support/scratch.ts";
import { until } from "../support/browser-herdr.ts";

test("Sheprd opens the captain viewer and forwarded loopback ports still need its token", async () => {
  const scratch = new Scratch();
  const home = join(scratch.parent, "home");
  const bin = join(home, ".local/state/herdr/gpui/bin");
  const record = join(scratch.parent, "opened");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sheprd"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`, {
    mode: 0o755,
  });
  for (const opener of ["open", "xdg-open"]) {
    writeFileSync(join(bin, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  configureMain(scratch, "ws://127.0.0.1:1/session", "scratch-token");
  const viewer = spawnGuarded(
    "node",
    [
      join(scratch.root, "packages/extension/src/browser-view.ts"),
      "--home",
      scratch.root,
      "--captain",
      "--open",
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
  viewer.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const forward = createServer((incoming, response) => {
    const target = new URL(url);
    const upstream = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: incoming.url,
        headers: incoming.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on("error", () => response.writeHead(502).end());
    incoming.pipe(upstream);
  });
  let url = "";
  try {
    url = await until("the captain viewer address", () =>
      Promise.resolve(/Fleet browser viewer \(captain\): (\S+)/.exec(output)?.[1]),
    );
    await new Promise<void>((resolve) => forward.listen(0, "127.0.0.1", resolve));
    const address = forward.address();
    assert.ok(address !== null && typeof address !== "string");
    const forwarded = new URL(url);
    forwarded.port = String(address.port);
    const entered = await fetch(forwarded, { redirect: "manual" });
    assert.equal(entered.status, 302);
    const cookie = entered.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie !== undefined);
    forwarded.search = "";
    assert.equal((await fetch(forwarded)).status, 403);
    const served = await fetch(forwarded, { headers: { cookie } });
    assert.equal(served.status, 200);
    assert.match(await served.text(), /<html/);
    assert.equal(
      (await fetch(forwarded, { headers: { cookie, origin: "http://evil.example" } })).status,
      403,
    );
    await until("Sheprd's open request", () =>
      Promise.resolve(existsSync(record) ? true : undefined),
    );
    assert.deepEqual(readFileSync(record, "utf8").trim().split("\n"), [
      "browser",
      "open",
      "--tab",
      url,
    ]);
    assert.ok((new URL(url).searchParams.get("t") ?? "").length >= 32);
  } finally {
    forward.closeAllConnections();
    await new Promise<void>((resolve) => {
      forward.close(() => {
        resolve();
      });
    });
    const exited = once(viewer, "exit");
    viewer.kill("SIGTERM");
    await exited;
    scratch.dispose();
  }
});
