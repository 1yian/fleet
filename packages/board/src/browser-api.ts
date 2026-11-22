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

const RETRY_MS = [1000, 2000, 4000, 8000, 15000];

export interface Stream {
  readonly close: () => void;
  readonly restart: () => void;
}

export function openStream(
  url: string,
  hooks: {
    readonly wire: (source: EventSource, ready: () => void) => void;
    readonly failed: () => void;
    readonly opened?: () => void;
  },
): Stream {
  let source: EventSource | undefined;
  let attempt = 0;
  let timer = 0;
  let stopped = false;
  const open = (): void => {
    const next = new EventSource(url);
    source = next;
    next.addEventListener("open", () => {
      hooks.opened?.();
    });
    next.addEventListener("error", () => {
      if (stopped || source !== next) return;
      next.close();
      hooks.failed();
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 15_000;
      attempt += 1;
      timer = window.setTimeout(open, delay);
    });
    hooks.wire(next, () => {
      if (source === next) attempt = 0;
    });
  };
  open();
  return {
    close: () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
    },
    restart: () => {
      if (stopped) return;
      clearTimeout(timer);
      source?.close();
      open();
    },
  };
}

export function useBrowserLanes(enabled: boolean) {
  const [lanes, setLanes] = useState<ReadonlyMap<string, BrowserLane>>(new Map());
  const [feed, setFeed] = useState<"connecting" | "open" | "offline">("connecting");
  useEffect(() => {
    if (!enabled) return;
    const stream = openStream("/api/browser/events", {
      opened: () => {
        setLanes(new Map());
        setFeed("open");
      },
      failed: () => {
        setFeed("offline");
      },
      wire: (source, ready) => {
        jsonEvent(
          source,
          "lane",
          (data) => check(BrowserLaneSchema, data),
          (lane) => {
            ready();
            setLanes((current) => new Map(current).set(lane.lane, lane));
          },
        );
        jsonEvent(
          source,
          "gone",
          (data) => check(BrowserLaneKey, data),
          ({ lane }) => {
            ready();
            setLanes((current) => {
              const next = new Map(current);
              next.delete(lane);
              return next;
            });
          },
        );
      },
    });
    return stream.close;
  }, [enabled]);
  return { lanes, feed };
}

export function browserHref(lane?: string): string {
  return lane === undefined ? "#/browser" : `#/browser/${lane}`;
}

export function openHandoff(lane: BrowserLane | undefined): string | undefined {
  return lane?.handoff?.status === "open" ? lane.handoff.reason : undefined;
}
