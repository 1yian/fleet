import type { DatabaseSync } from "node:sqlite";

type MateStop = { readonly kind: "up" } | { readonly kind: "stopping"; readonly until: number };

type StopEvent =
  | { readonly event: "mark"; readonly now: number; readonly window: number }
  | { readonly event: "connect" };

function nextStop(event: StopEvent): MateStop {
  switch (event.event) {
    case "mark":
      return { kind: "stopping", until: event.now + event.window };
    case "connect":
      return { kind: "up" };
  }
}

export function stopOf(until: number | null, now: number): MateStop {
  if (until !== null && until > now) return { kind: "stopping", until };
  return { kind: "up" };
}

export function transitionStop(db: DatabaseSync, session: string, event: StopEvent): MateStop {
  const stop = nextStop(event);
  db.prepare("UPDATE sessions SET stopping_until = ? WHERE id = ? AND role = 'mate'").run(
    stop.kind === "stopping" ? stop.until : null,
    session,
  );
  return stop;
}

export function untilOf(row: Record<string, unknown>): number | null {
  const until = row["until"];
  return typeof until === "number" ? until : null;
}
