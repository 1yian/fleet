import { useEffect, useState } from "react";
import { BrowserLaneKey, BrowserLaneSchema, check, type BrowserLane } from "@fleet/protocol";

export function jsonEvent<T>(
  source: EventSource,
  name: string,
  parse: (data: unknown) => T,
  accept: (data: T) => void,
): void {
  source.addEventListener(name, (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "string") return;
    let data: T;
    try {
      data = parse(JSON.parse(event.data));
    } catch {
      return;
    }
    accept(data);
  });
}

export function useBrowserLanes(enabled: boolean) {
  const [lanes, setLanes] = useState<ReadonlyMap<string, BrowserLane>>(new Map());
  const [feed, setFeed] = useState<"connecting" | "open" | "offline">("connecting");
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/browser/events");
    source.onopen = () => {
      setLanes(new Map());
      setFeed("open");
    };
    source.onerror = () => {
      setFeed("offline");
    };
    jsonEvent(
      source,
      "lane",
      (data) => check(BrowserLaneSchema, data),
      (lane) => {
        setLanes((current) => new Map(current).set(lane.lane, lane));
      },
    );
    jsonEvent(
      source,
      "gone",
      (data) => check(BrowserLaneKey, data),
      ({ lane }) => {
        setLanes((current) => {
          const next = new Map(current);
          next.delete(lane);
          return next;
        });
      },
    );
    return () => {
      source.close();
    };
  }, [enabled]);
  return { lanes, feed };
}

export function browserHref(lane?: string): string {
  return lane === undefined ? "#/browser" : `#/browser/${lane}`;
}

export function openHandoff(lane: BrowserLane | undefined): string | undefined {
  return lane?.handoff?.status === "open" ? lane.handoff.reason : undefined;
}
