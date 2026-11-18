import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function lavishRequest(url: URL, body?: object): Promise<Response> {
  return fetch(url, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", origin: url.origin },
          body: JSON.stringify(body),
        }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
}

async function localOrigin(): Promise<URL> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no Lavish port"));
        else resolve(new URL(`http://127.0.0.1:${String(address.port)}`));
      });
    });
  });
}

export interface ReviewSession {
  readonly token: string;
  readonly url: URL;
  readonly stop: () => void;
  readonly ended: () => boolean;
}

async function snapshot(source: URL): Promise<Uint8Array> {
  const response = await lavishRequest(
    new URL(`${source.pathname.replace("/session/", "/api/")}/export`, source),
  );
  if (
    !response.ok ||
    response.body === null ||
    response.headers.get("x-lavish-export-warning-count") !== "0"
  ) {
    await response.body?.cancel();
    throw new Error("Lavish could not export a portable review artifact; answer on the board");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks, size);
      size += part.value.length;
      if (size > 16 * 1024 * 1024) throw new Error("review artifact is too large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
}

export async function launchReview(source: URL): Promise<ReviewSession> {
  const html = await snapshot(source);
  const origin = await localOrigin();
  const dir = await mkdtemp(join(await realpath(tmpdir()), "fleet-review-"));
  const clean = () => rm(dir, { recursive: true, force: true });
  const file = join(dir, "review.html");
  try {
    await writeFile(file, html, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await clean();
    throw error;
  }
  const child = spawn("lavish-axi", ["server", "--port", origin.port], {
    cwd: dir,
    env: { PATH: process.env["PATH"], LAVISH_AXI_HOST: "127.0.0.1", LAVISH_AXI_STATE_DIR: dir },
    stdio: "ignore",
  });
  let stopped = false;
  child.once("error", () => {
    stopped = true;
  });
  child.once("close", () => {
    stopped = true;
    void clean().catch((error: unknown) => console.warn("Lavish review cleanup failed", error));
  });
  child.unref();
  const stop = () => {
    if (!stopped) child.kill();
  };
  try {
    const deadline = Date.now() + 5000;
    while (!stopped && Date.now() < deadline) {
      const health = await fetch(new URL("/health", origin), {
        redirect: "error",
        signal: AbortSignal.timeout(500),
      }).catch(() => undefined);
      const state: unknown = health?.ok === true ? await health.json() : undefined;
      if (
        typeof state === "object" &&
        state !== null &&
        Reflect.get(state, "state_dir") === dir &&
        Reflect.get(state, "version") === "0.1.97"
      ) {
        const opened = await lavishRequest(new URL("/api/sessions", origin), { file });
        const result: unknown = await opened.json();
        if (
          opened.ok &&
          typeof result === "object" &&
          result !== null &&
          Reflect.get(result, "status") === "opened"
        ) {
          const key: unknown = Reflect.get(result, "key");
          if (typeof key === "string" && /^[a-f0-9]{16}$/.test(key))
            return {
              token: randomUUID(),
              url: new URL(`/session/${key}`, origin),
              stop,
              ended: () => stopped,
            };
        }
        break;
      }
      await health?.body?.cancel().catch(() => undefined);
      await delay(25);
    }
    throw new Error("Fleet could not launch stock Lavish 0.1.97; answer on the board");
  } catch (error) {
    stop();
    throw error;
  }
}
