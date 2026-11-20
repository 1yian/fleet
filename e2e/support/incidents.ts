import { check, OPS, type Card, type Entry } from "@fleet/protocol";
import type { Session } from "./cardd.ts";
import type { Fleet } from "./fleet.ts";

export const is =
  (condition: string) =>
  (entry: Entry): boolean =>
    entry.fields["condition"] === condition;

export async function reportFailure(
  fleet: Fleet,
  mate: Session,
  card: Card,
  error: string,
  model?: string,
): Promise<Session> {
  const plan = check(
    OPS["attempt.begin"].result,
    await mate.call("attempt.begin", {
      card: card.id,
      host: "maverick",
      task: "the task",
      ...(model === undefined ? {} : { model }),
    }),
  );
  const worker = await fleet.cardd.connect(plan.token);
  await worker.call("incident.report", { error });
  return worker;
}
