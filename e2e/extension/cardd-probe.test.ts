import assert from "node:assert/strict";
import { createServer, connect, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { Harness, type Pi, type Turn } from "../support/harness.ts";
import { tempDir } from "../support/run-root.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const WAIT_MS = 30_000;

class Doorman {
  refusing = false;
  readonly server: Server;
  private readonly open = new Set<Socket>();
  private readonly upstream: { host: string; port: number };
  private readonly self: { port: number } = { port: 0 };

  private constructor(upstream: { host: string; port: number }) {
    this.upstream = upstream;
    this.server = createServer((client) => {
      this.accept(client);
    });
  }

  static async start(upstream: { host: string; port: number }): Promise<Doorman> {
    const door = new Doorman(upstream);
    await new Promise<void>((resolve) => door.server.listen(0, "127.0.0.1", resolve));
    const address = door.server.address();
    door.self.port = typeof address === "object" && address !== null ? address.port : 0;
    return door;
  }

  get port(): number {
    return this.self.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private accept(client: Socket): void {
    this.open.add(client);
    client.on("close", () => this.open.delete(client));
    client.on("error", () => undefined);
    if (this.refusing) {
      client.resetAndDestroy();
      return;
    }
    const upstream = connect(this.upstream);
    this.open.add(upstream);
    upstream.on("close", () => {
      this.open.delete(upstream);
      client.destroy();
    });
    upstream.on("error", () => {
      client.destroy();
    });
    client.on("close", () => upstream.destroy());
    let first = true;
    client.on("data", (chunk: Buffer) => {
      if (first) {
        first = false;
        const text = chunk
          .toString("latin1")
          .replace(
            `127.0.0.1:${String(this.port)}`,
            `${this.upstream.host}:${String(this.upstream.port)}`,
          );
        upstream.write(Buffer.from(text, "latin1"));
      } else upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => client.write(chunk));
  }
}

let cardd: Cardd;
let h: Harness;
let door: Doorman;
let mate: Pi;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  const home = tempDir("fleet-home-");
  const token = cardd.addLane("main", undefined, home);
  const upstream = new URL(cardd.url.replace(/^ws/, "http"));
  door = await Doorman.start({ host: upstream.hostname, port: Number(upstream.port) });
  mate = h.startPi(
    "main",
    {
      FLEET_URL: `ws://127.0.0.1:${String(door.port)}/session`,
      FLEET_TOKEN: token,
      FLEET_ROLE: "mate",
      FLEET_FAKE_AGENT: "mate",
      FLEET_PROBE_INTERVAL_MS: "250",
      FLEET_PROBE_DEADLINE_MS: "1000",
      FLEET_PROBE_FAILS: "3",
      FLEET_PROBE_DOWN_FAILS: "40",
    },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "main to connect");
});
afterEach(async () => {
  const stopped = await Promise.allSettled([h.stop(), door.stop(), cardd.stop()]);
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const probeLines = (turns: Turn[]): string[] =>
  turns
    .filter((turn) => turn.role === "user" && turn.text.includes("cardd probe:"))
    .map((t) => t.text);

async function lastTurns(match: (lines: string[]) => boolean, what: string): Promise<string[]> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const lines = probeLines(h.callsOf("mate").at(-1) ?? []);
    if (match(lines)) return lines;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("main is told once when cardd refuses new connections, and once when it recovers", async () => {
  door.refusing = true;
  const alerted = await lastTurns((lines) => lines.length >= 1, "the alert");
  assert.match(alerted[0] ?? "", /refusing new connections/);
  assert.match(alerted[0] ?? "", /refusing-new/);
  door.refusing = false;
  const healed = await lastTurns((lines) => lines.length >= 2, "the recovered line");
  assert.equal(healed.length, 2);
  assert.match(healed[1] ?? "", /answers again/);
  mate.prompt("anything else?");
  await h.waitForCall(h.callsOf("mate").length, "mate");
  assert.equal(probeLines(h.callsOf("mate").at(-1) ?? []).length, 2);
});

test("a normal cardd restart does not alert main", async () => {
  await cardd.restart();
  await h.waitForNth((e) => e["type"] === "fleet_connected", 2, "main to reconnect");
  mate.prompt("status?");
  const turns = await h.waitForCall(h.callsOf("mate").length, "mate");
  assert.deepEqual(probeLines(turns), []);
});
