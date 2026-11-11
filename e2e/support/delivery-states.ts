import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export interface Which {
  readonly role?: "worker" | "mate";
  readonly kind?: string;
  readonly session?: string;
}

export function deliveryStates(db: string, which: Which = {}): string[] {
  const handle = new DatabaseSync(db, { readOnly: true });
  try {
    return handle
      .prepare(
        "SELECT d.state AS state FROM deliveries d JOIN sessions s ON s.id = d.session JOIN entries e ON e.id = d.entry WHERE s.role = ?1 AND (?2 IS NULL OR e.kind = ?2) AND (?3 IS NULL OR d.session = ?3) ORDER BY d.entry",
      )
      .all(which.role ?? "worker", which.kind ?? null, which.session ?? null)
      .map((row) => String(row["state"]));
  } finally {
    handle.close();
  }
}

export const isTaken = (state: string): boolean =>
  state === "acknowledged" || state === "confirmed";

export async function waitForTakenIn(db: string, which: Which = {}): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const states = deliveryStates(db, which);
    if (states.length > 0 && states.every(isTaken)) return;
    assert.ok(Date.now() < deadline, `the message was not taken in: ${JSON.stringify(states)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
