import type { Entry } from "@fleet/protocol";
import type { Session } from "./cardd.ts";
import { begin, newCard, type Fleet } from "./fleet.ts";

export function missedAbout(fleet: Fleet, card: number): Entry[] {
  return fleet.main.entries
    .map((push) => push.entry)
    .filter((entry) => entry.card === card && entry.fields["condition"] === "missed");
}

export interface UntakenControl {
  readonly worker: Session;
  readonly reportedMissed: () => Promise<Entry>;
}

export async function untakenControl(fleet: Fleet, title: string): Promise<UntakenControl> {
  const card = await newCard(fleet.main, title);
  const worker = await fleet.cardd.connect(await begin(fleet.main, card), [], false);
  return {
    worker,
    reportedMissed: async () =>
      fleet.main.waitForEntry(
        (entry) => entry.card === card.id && entry.fields["condition"] === "missed",
        "main to hear that the control worker never took in its task",
      ),
  };
}
