import { HostUnread } from "./host.ts";
import { discoverLanes, laneClaimsRaced, unreadFailure, type LaneHome } from "./lane-homes.ts";
import {
  confirmLifecycle,
  heldReasonOf,
  lifecycleMoved,
  recentStartsOf,
  sampleLifecycle,
  type Lifecycle,
} from "./lane-lifecycle.ts";
import { racedRosters, workspaceOf, type Listed } from "./lane-observation.ts";

export interface Status {
  readonly lane: string;
  readonly state: "running" | "down" | "stopped" | "unknown";
  readonly reason?: string;
}
interface Seen {
  lane: string;
  seen: Listed;
}

async function statusOf(
  info: LaneHome,
): Promise<{ row: Status; sample?: Lifecycle; seen?: Listed | undefined }> {
  const { lane, home } = info;
  try {
    const sample = sampleLifecycle(home);
    const reason = heldReasonOf(sample[0]);
    recentStartsOf(sample[1], Date.now());
    const roster: { roster?: Listed } = {};
    const observed = await workspaceOf(info, "liveness", undefined, roster);
    const seen = roster.roster;
    if (observed?.state === "running") return { row: { lane, state: "running" }, sample, seen };
    if (reason === undefined) return { row: { lane, state: "down" }, sample, seen };
    return { row: { lane, state: "stopped", reason }, sample, seen };
  } catch (error) {
    if (error instanceof HostUnread)
      return { row: { lane, state: "unknown", reason: error.message } };
    throw error;
  }
}

export async function status(root: string): Promise<Status[]> {
  const { homes, unread } = discoverLanes(root);
  const read: { info: LaneHome; row: Status; sample?: Lifecycle; seen?: Listed | undefined }[] = [];
  for (const info of homes) read.push({ info, ...(await statusOf(info)) });
  const rosters = await racedRosters(
    read.flatMap(({ row, seen }): Seen[] => (seen === undefined ? [] : [{ lane: row.lane, seen }])),
  );
  const { changed, added } = laneClaimsRaced(root, homes, unread);
  const out = read.map(({ info, row, sample }): Status => {
    if (sample === undefined) return row;
    const reason = changed.get(row.lane) ?? lifecycleMoved(info, sample) ?? rosters.get(row.lane);
    return reason === undefined ? row : { lane: row.lane, state: "unknown", reason };
  });
  for (const { lane, message } of [...unread, ...added])
    out.push({ lane, state: "unknown", reason: message });
  return out;
}

export async function placementStatus(
  root: string,
): Promise<{ lane: string; mate: boolean; host?: string }[]> {
  const { homes, unread } = discoverLanes(root);
  if (unread.length > 0) throw new Error(unreadFailure(unread));
  const out: { lane: string; mate: boolean; host?: string }[] = [];
  const samples: Lifecycle[] = [];
  const seen: Seen[] = [];
  for (const info of homes) {
    const sample = sampleLifecycle(info.home);
    recentStartsOf(sample[1], Date.now());
    samples.push(sample);
    const roster: { roster?: Listed } = {};
    const mate = (await workspaceOf(info, "placement", undefined, roster)) !== undefined;
    if (roster.roster !== undefined) seen.push({ lane: info.lane, seen: roster.roster });
    out.push({
      lane: info.lane,
      mate,
      ...(info.config.host === undefined ? {} : { host: info.config.host }),
    });
  }
  const rosters = await racedRosters(seen);
  const { changed, added, failed } = laneClaimsRaced(root, homes);
  const [first] = [...changed.values(), ...rosters.values()];
  if (first !== undefined) throw new HostUnread(first);
  if (failed) throw new HostUnread("the lane roster could not be read again after placement");
  if (added.length > 0)
    throw new HostUnread("the lane roster changed while placement was being read");
  for (const [at, info] of homes.entries()) confirmLifecycle(info, samples[at] ?? ["", ""]);
  return out;
}
