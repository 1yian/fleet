import type { Card, Entry } from "@fleet/protocol";
import type { Session } from "./cardd.ts";

export const reach = (
  session: Session,
  card: Card,
  condition: string,
  tier: number,
): Promise<Entry> =>
  session.waitForEntry(
    (entry) =>
      entry.card === card.id &&
      entry.fields["condition"] === condition &&
      Number(entry.fields["tier"]) >= tier,
    `${condition} tier ${String(tier)} on c-${String(card.id)}`,
  );
