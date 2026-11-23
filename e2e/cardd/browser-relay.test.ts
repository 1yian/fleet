import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boundBoardFile, startBoardServer } from "../support/board.ts";
import { tempDir } from "../support/run-root.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const COMMAND = JSON.stringify({ t: "tab", action: "activate", id: "one" });

boundBoardFile();

test("the relay does not dispatch an upstream command after the board has disconnected", async (t) => {
  const reached: string[] = [];
  const upstream = createServer((request, response) => {
    reached.push(`${request.method ?? ""} ${request.url ?? ""}`);
    response.writeHead(200).end();
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const fifo = join(tempDir("browser-relay-"), "token");
  execFileSync("mkfifo", [fifo]);
  const cardd = await startBoardServer(t, BOARD, {
    CARDD_BROWSER_ORIGIN: `http://127.0.0.1:${String(address.port)}`,
    CARDD_BROWSER_TOKEN_FILE: fifo,
  });
  const base = new URL(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
  const post = async (disconnect: boolean): Promise<number | undefined> => {
    const reader = open(fifo, "w");
    const status = new Promise<number | undefined>((resolve) => {
      const outgoing = httpRequest(
        new URL("/api/browser/lanes/garden/command?viewer=relay", base),
        { method: "POST", headers: { "content-type": "application/json", origin: base.origin } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      outgoing.on("error", () => {
        resolve(undefined);
      });
      outgoing.end(COMMAND);
      void reader.then(() => {
        if (disconnect) outgoing.destroy();
      });
    });
    const handle = await reader;
    if (disconnect) await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.write("relay-token");
    await handle.close();
    return status;
  };
  assert.equal(await post(false), 204);
  assert.deepEqual(reached, ["POST /v1/lanes/garden/command?viewer=relay"]);
  assert.equal(await post(true), undefined);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(reached.length, 1);
});
