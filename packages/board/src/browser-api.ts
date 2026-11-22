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

export function openStream(
  url: string,
  hooks: {
    readonly wire: (source: EventSource) => void;
    readonly failed: () => void;
    readonly opened?: () => void;
  },
): () => void {
  let source: EventSource | undefined;
  let attempt = 0;
  let timer = 0;
  let stopped = false;
  const open = (): void => {
    const next = new EventSource(url);
    source = next;
    next.addEventListener("open", () => {
      attempt = 0;
      hooks.opened?.();
    });
    next.addEventListener("error", () => {
      hooks.failed();
      if (stopped || next.readyState !== EventSource.CLOSED) return;
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 15_000;
      attempt += 1;
      timer = window.setTimeout(open, delay);
    });
    hooks.wire(next);
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
}

export function useBrowserLanes(enabled: boolean) {
  const [lanes, setLanes] = useState<ReadonlyMap<string, BrowserLane>>(new Map());
  const [feed, setFeed] = useState<"connecting" | "open" | "offline">("connecting");
  useEffect(() => {
    if (!enabled) return;
    return openStream("/api/browser/events", {
      opened: () => {
        setLanes(new Map());
        setFeed("open");
      },
      failed: () => {
        setFeed("offline");
      },
      wire: (source) => {
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
      },
    });
  }, [enabled]);
  return { lanes, feed };
}

export function browserHref(lane?: string): string {
  return lane === undefined ? "#/browser" : `#/browser/${lane}`;
}

export function openHandoff(lane: BrowserLane | undefined): string | undefined {
  return lane?.handoff?.status === "open" ? lane.handoff.reason : undefined;
}
