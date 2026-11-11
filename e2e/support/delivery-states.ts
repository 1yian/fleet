import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

export function workerDeliveryStates(db: string, kind?: string): string[] {
  const handle = new DatabaseSync(db, { readOnly: true });
  try {
    return handle
      .prepare(
        "SELECT d.state AS state FROM deliveries d JOIN sessions s ON s.id = d.session JOIN entries e ON e.id = d.entry WHERE s.role = 'worker' AND (?1 IS NULL OR e.kind = ?1) ORDER BY d.entry",
      )
      .all(kind ?? null)
      .map((row) => String(row["state"]));
  } finally {
    handle.close();
  }
}

export const isTaken = (state: string): boolean =>
  state === "acknowledged" || state === "confirmed";

export async function waitForTakenIn(db: string, kind?: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const states = workerDeliveryStates(db, kind);
    if (states.length > 0 && states.every(isTaken)) return;
    assert.ok(Date.now() < deadline, `the message was not taken in: ${JSON.stringify(states)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
