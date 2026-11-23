import { NEVER, type BridgeStatus } from "./health.ts";

const FILE_STALE_MS = 15_000;
const POLL_STALE_MS = 15_000;
const HEARTBEAT_GRACE_MS = 5_000;
const NOT_CURRENT = "NOT CURRENT, last known values only";

type Outcomes = BridgeStatus["poll"];

function timeOf(stamp: string): number | undefined {
  const time = Date.parse(stamp);
  return Number.isNaN(time) ? undefined : time;
}

function within(stamp: string, at: number, limit: number): boolean {
  const time = timeOf(stamp);
  return time !== undefined && time <= at && at - time <= limit;
}

function shown(stamp: string): string {
  return timeOf(stamp) === undefined ? NEVER : stamp;
}

function failedLast(outcomes: Outcomes): boolean {
  const failed = timeOf(outcomes.failedAt);
  if (failed === undefined) return false;
  return failed >= (timeOf(outcomes.okAt) ?? -Infinity);
}

function pollVerdict(poll: Outcomes, at: number): string {
  if (failedLast(poll)) return "FAILING";
  if (timeOf(poll.okAt) === undefined) return "UNKNOWN, no poll has succeeded yet";
  return within(poll.okAt, at, POLL_STALE_MS) ? "ok" : "STALE, no recent success";
}

function startupVerdict(poll: Outcomes): string {
  if (failedLast(poll)) return "not started, the startup read FAILED";
  return timeOf(poll.okAt) === undefined
    ? "UNKNOWN, not started, no startup read has succeeded yet"
    : "not started, the startup read succeeded";
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
  if (ack === undefined || ack <= (timeOf(presence.lostAt) ?? -Infinity))
    return "UNKNOWN, no heartbeat acknowledged on this connection yet";
  return within(presence.ackAt, at, presence.heartbeatMs * 2 + HEARTBEAT_GRACE_MS)
    ? "ok"
    : "STALE, heartbeat acknowledgements stopped";
}

function speechLine(speech: BridgeStatus["speech"]): string {
  if (speech.result === NEVER) return `speech (${speech.engine}): never used`;
  return `speech (${speech.engine}): last result ${speech.result}, ${shown(speech.at)}`;
}

function isLive(status: BridgeStatus, at: number): boolean {
  return within(status.writtenAt, at, FILE_STALE_MS) && status.state !== "stopped";
}

function headline(status: BridgeStatus, at: number): string {
  if (!within(status.writtenAt, at, FILE_STALE_MS))
    return `STALE: status last written ${shown(status.writtenAt)}, so the bridge is stopped or stuck, or the clock moved. Values below are history, not current.`;
  if (status.state === "wrong-guild")
    return "off: BRIDGE_CHANNEL_ID is not in BRIDGE_GUILD_ID, so nothing is polled or posted";
  if (status.state === "starting") return "starting: not polling yet";
  if (status.state === "stopped") return "stopped. Values below are history, not current.";
  return `running since ${shown(status.startedAt)}`;
}

export function bridgeReport(status: BridgeStatus | undefined, at: number): string {
  if (status === undefined)
    return "discord bridge: UNKNOWN, no readable status file (the bridge has not started, or the file is damaged)";
  const { poll, injection, post, presence } = status;
  const live = isLive(status, at);
  const verdict = (current: string): string => (live ? current : NOT_CURRENT);
  return [
    `discord bridge: ${headline(status, at)}`,
    `polling Discord: ${verdict(status.state === "starting" ? startupVerdict(poll) : pollVerdict(poll, at))}`,
    `  last success: ${shown(poll.okAt)}`,
    `  last error: ${shown(poll.failedAt)}`,
    `injection into this session: ${verdict(eventVerdict(injection))}`,
    `  last success: ${shown(injection.okAt)}`,
    `  last error: ${shown(injection.failedAt)}`,
    `posting to Discord: ${verdict(eventVerdict(post))}`,
    `  last success: ${shown(post.okAt)}`,
    `  last error: ${shown(post.failedAt)}`,
    `presence (the bot shown online, not needed for delivery): ${verdict(presenceVerdict(presence, at))}`,
    `  connected${live ? "" : " when last written"}: ${presence.connected ? "yes" : "no"}`,
    `  last READY: ${shown(presence.readyAt)}`,
    `  last heartbeat ack: ${shown(presence.ackAt)}`,
    speechLine(status.speech),
  ].join("\n");
}
