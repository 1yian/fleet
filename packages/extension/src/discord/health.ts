import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { describeError, type Log } from "./log.ts";

export const NEVER = "never";
const WRITE_MS = 5_000;

const Stamp = Type.String();
const Outcomes = Type.Object({ okAt: Stamp, failedAt: Stamp });

export const BridgeStatus = Type.Object({
  writtenAt: Stamp,
  startedAt: Stamp,
  state: Type.Union([
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("wrong-guild"),
    Type.Literal("stopped"),
  ]),
  poll: Outcomes,
  injection: Outcomes,
  post: Outcomes,
  presence: Type.Object({
    connected: Type.Boolean(),
    readyAt: Stamp,
    ackAt: Stamp,
    lostAt: Stamp,
    heartbeatMs: Type.Number(),
  }),
  speech: Type.Object({
    engine: Type.Union([Type.Literal("local"), Type.Literal("groq")]),
    result: Type.Union([
      Type.Literal("never"),
      Type.Literal("ok"),
      Type.Literal("failed"),
      Type.Literal("no speech"),
    ]),
    at: Stamp,
  }),
});

export type BridgeStatus = Static<typeof BridgeStatus>;
export type Layer = "poll" | "injection" | "post";
export type SpeechResult = BridgeStatus["speech"]["result"];

const now = (): string => new Date().toISOString();

export function readStatus(file: string): BridgeStatus | undefined {
  try {
    const body: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Value.Check(BridgeStatus, body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function forget(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    return;
  }
}

export class Health {
  private readonly file: string;
  private readonly log: Log;
  private readonly status: BridgeStatus;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(file: string, engine: BridgeStatus["speech"]["engine"], log: Log) {
    this.file = file;
    this.log = log;
    this.status = {
      writtenAt: now(),
      startedAt: now(),
      state: "starting",
      poll: { okAt: NEVER, failedAt: NEVER },
      injection: { okAt: NEVER, failedAt: NEVER },
      post: { okAt: NEVER, failedAt: NEVER },
      presence: { connected: false, readyAt: NEVER, ackAt: NEVER, lostAt: NEVER, heartbeatMs: 0 },
      speech: { engine, result: NEVER, at: NEVER },
    };
  }

  start(): void {
    this.write();
    this.timer = setInterval(() => {
      this.write();
    }, WRITE_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.status.presence.connected = false;
    this.state("stopped");
    this.stopped = true;
  }

  state(value: BridgeStatus["state"]): void {
    this.status.state = value;
    this.write();
  }

  succeeded(layer: Layer): void {
    this.status[layer].okAt = now();
    this.write();
  }

  failed(layer: Layer): void {
    this.status[layer].failedAt = now();
    this.write();
  }

  heartbeatEvery(milliseconds: number): void {
    this.status.presence.heartbeatMs = milliseconds;
    this.write();
  }

  ready(): void {
    this.status.presence = {
      ...this.status.presence,
      connected: true,
      readyAt: now(),
    };
    this.write();
  }

  acknowledged(): void {
    this.status.presence.ackAt = now();
    this.write();
  }

  lost(): void {
    this.status.presence = { ...this.status.presence, connected: false, lostAt: now() };
    this.write();
  }

  spoke(result: SpeechResult): void {
    this.status.speech = { ...this.status.speech, result, at: now() };
    this.write();
  }

  private write(): void {
    if (this.stopped) return;
    this.status.writtenAt = now();
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(this.status, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } catch (error) {
      this.log(`the status file was not written: ${describeError(error)}`);
      forget(temporary);
    }
  }
}
