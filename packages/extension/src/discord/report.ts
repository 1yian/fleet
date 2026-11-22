import { NEVER, type BridgeStatus } from "./health.ts";

const FILE_STALE_MS = 15_000;
const POLL_STALE_MS = 15_000;
const HEARTBEAT_GRACE_MS = 5_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

type Outcomes = BridgeStatus["poll"];

function timeOf(stamp: string): number | undefined {
  const time = Date.parse(stamp);
  return Number.isNaN(time) ? undefined : time;
}

function ago(milliseconds: number): string {
  if (milliseconds < MINUTE_MS)
    return `${String(Math.max(0, Math.round(milliseconds / 1000)))}s ago`;
  if (milliseconds < HOUR_MS) return `${String(Math.round(milliseconds / MINUTE_MS))}m ago`;
  return `${String(Math.round(milliseconds / HOUR_MS))}h ago`;
}

function shown(stamp: string, at: number): string {
  const time = timeOf(stamp);
  return time === undefined ? NEVER : `${stamp} (${ago(at - time)})`;
}

function failedLast(outcomes: Outcomes): boolean {
  const failed = timeOf(outcomes.failedAt);
  if (failed === undefined) return false;
  return failed >= (timeOf(outcomes.okAt) ?? -Infinity);
}

function pollVerdict(poll: Outcomes, at: number): string {
  const ok = timeOf(poll.okAt);
  if (failedLast(poll)) return "FAILING";
  if (ok === undefined) return "UNKNOWN, no poll has succeeded yet";
  return at - ok > POLL_STALE_MS ? "STALE, no recent success" : "ok";
}

function eventVerdict(outcomes: Outcomes): string {
  if (failedLast(outcomes)) return "FAILING, the last attempt failed";
  return timeOf(outcomes.okAt) === undefined ? "never happened" : "last attempt succeeded";
}

function presenceVerdict(presence: BridgeStatus["presence"], at: number): string {
  if (!presence.connected)
    return timeOf(presence.lostAt) === undefined
      ? "UNKNOWN, not connected yet"
      : "DISCONNECTED, reconnecting";
  const ack = timeOf(presence.ackAt);
  if (ack === undefined) return "UNKNOWN, no heartbeat acknowledged yet";
  return at - ack > presence.heartbeatMs * 2 + HEARTBEAT_GRACE_MS
    ? "STALE, heartbeat acknowledgements stopped"
    : "ok";
}

function speechLine(speech: BridgeStatus["speech"], at: number): string {
  if (speech.result === NEVER) return `speech (${speech.engine}): never used`;
  return `speech (${speech.engine}): last result ${speech.result}, ${shown(speech.at, at)}`;
}

function headline(status: BridgeStatus, at: number): string {
  const written = timeOf(status.writtenAt);
  if (written === undefined || at - written > FILE_STALE_MS)
    return `STALE: status last written ${shown(status.writtenAt, at)}, so the bridge is stopped or stuck. Values below are from then.`;
  if (status.state === "wrong-guild")
    return "off: BRIDGE_CHANNEL_ID is not in BRIDGE_GUILD_ID, so nothing is polled or posted";
  if (status.state === "starting") return "starting: not polling yet";
  if (status.state === "stopped") return "stopped";
  return `running since ${shown(status.startedAt, at)}`;
}

export function bridgeReport(status: BridgeStatus | undefined, at: number): string {
  if (status === undefined)
    return "discord bridge: UNKNOWN, no readable status file (the bridge has not started, or the file is damaged)";
  const { poll, injection, post, presence } = status;
  return [
    `discord bridge: ${headline(status, at)}`,
    `polling Discord: ${pollVerdict(poll, at)}`,
    `  last success: ${shown(poll.okAt, at)}`,
    `  last error: ${shown(poll.failedAt, at)}`,
    `injection into this session: ${eventVerdict(injection)}`,
    `  last success: ${shown(injection.okAt, at)}`,
    `  last error: ${shown(injection.failedAt, at)}`,
    `posting to Discord: ${eventVerdict(post)}`,
    `  last success: ${shown(post.okAt, at)}`,
    `  last error: ${shown(post.failedAt, at)}`,
    `presence (the bot shown online, not needed for delivery): ${presenceVerdict(presence, at)}`,
    `  connected: ${presence.connected ? "yes" : "no"}`,
    `  last READY: ${shown(presence.readyAt, at)}`,
    `  last heartbeat ack: ${shown(presence.ackAt, at)}`,
    speechLine(status.speech, at),
  ].join("\n");
}
