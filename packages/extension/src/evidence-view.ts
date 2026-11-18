import { evidenceScope, operationHandoff, type CardView } from "@fleet/protocol";
import { onHelper } from "./host.ts";
import { checkEvidenceCommand, retainedEvidenceCommand } from "./scratch.ts";

export type EvidenceShown =
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "retained"; readonly path: string }
  | { readonly kind: "unverified" }
  | { readonly kind: "unconfirmed" };

const CHECK_TIMEOUT_MS = 30_000;

async function confirmed(
  view: CardView,
  host: string,
  evidence: string,
  rel: string,
): Promise<EvidenceShown | undefined> {
  const { id, status } = view.card;
  try {
    if (status !== "done" && status !== "dropped") {
      await onHelper(host, checkEvidenceCommand(id, evidence), CHECK_TIMEOUT_MS);
      return { kind: "read", path: evidence };
    }
    const found = await onHelper(host, retainedEvidenceCommand(id, rel), CHECK_TIMEOUT_MS);
    return found.trim() === "" ? undefined : { kind: "retained", path: `${host}:${found.trim()}` };
  } catch {
    return undefined;
  }
}

function reported(view: CardView): { evidence: string; host: string | undefined } | undefined {
  const handoff = operationHandoff(view.entries);
  const evidence = handoff?.fields["evidence"];
  if (handoff === undefined || typeof evidence !== "string") return undefined;
  const attempt = /-a(\d+)$/.exec(handoff.author)?.[1];
  return { evidence, host: view.attempts.find((each) => String(each.n) === attempt)?.host };
}

export async function shownEvidence(view: CardView): Promise<EvidenceShown | undefined> {
  const { card } = view;
  const found = card.delivery === "ops" ? reported(view) : undefined;
  if (found === undefined) return undefined;
  const closed = card.status === "done" || card.status === "dropped";
  const unknown: EvidenceShown = { kind: closed ? "unconfirmed" : "unverified" };
  const scope = evidenceScope(card.id, found.evidence);
  if (scope === undefined || found.host === undefined) return unknown;
  return (await confirmed(view, found.host, found.evidence, scope.rel)) ?? unknown;
}
