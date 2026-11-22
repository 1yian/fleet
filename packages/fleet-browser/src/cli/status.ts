import type { LaneSnapshot } from "../shared/protocol.js";

export function renderStatus(snapshot: LaneSnapshot, ownTab?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    lane: snapshot.lane,
    browser: snapshot.status,
    chrome: snapshot.chromeVersion ?? "not started",
    control: snapshot.control.kind === "human" ? "captain (viewer)" : "agent",
    handoff: snapshot.handoff?.status === "open" ? `open: ${snapshot.handoff.reason}` : "none",
  };
  if (snapshot.error) out.error = snapshot.error;
  if (snapshot.viewLink) out.view = snapshot.viewLink;
  out.tabs = snapshot.tabs.map((tab) => ({
    title: tab.title,
    url: tab.url,
    ...(ownTab ? { owner: tab.id === ownTab ? "this card" : "other" } : {}),
  }));
  out.help = [
    snapshot.status === "ready"
      ? "Run `fleet-browser snapshot -i` to see the page"
      : "Run `fleet-browser start` to start the browser",
    "Run `fleet-browser open <url>` to navigate",
  ];
  return out;
}
