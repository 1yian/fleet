import type { OpResult } from "@fleet/protocol";
import { HostUnreachable, onHelper } from "./host.ts";
import { checkEvidenceCommand } from "./scratch.ts";

export async function requireEvidence(card: number, plan: OpResult<"close.begin">): Promise<void> {
  const { operation } = plan;
  const attempt = plan.attempts.find((each) => each.session === operation?.session);
  if (operation === undefined || attempt === undefined)
    throw new Error(
      `c-${String(card)} cannot close Done: its ops evidence has no attempt to read it on`,
    );
  try {
    await onHelper(attempt.host, checkEvidenceCommand(card, operation.evidence));
  } catch (error) {
    if (error instanceof HostUnreachable) throw error;
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `c-${String(card)} cannot close Done: its ops evidence ${operation.evidence} is not a readable report in the card's scratch folder on ${attempt.host}: ${why}`,
      { cause: error },
    );
  }
}
