import type { DatabaseSync } from "node:sqlite";
import type { Card, Next } from "@fleet/protocol";
import { factsFrom } from "./status.ts";
import { cardEntries, reachable, type Session } from "./store.ts";

export type NextStep =
  { readonly build: number } | { readonly decision: number } | { readonly drop: string };

const ROUTES_HELP =
  "Pass next with exactly one of build=<number of a ship card that carries the build, open or Done>, decision=<number of an open card whose decision waits on the captain: a hold on it that waits on him, or a captain-only card>, or drop=<why nothing is built>. Build directly when the captain already asked for the thing built, put a build-or-drop decision to him when he asked only for a plan, and drop when the findings make it moot";

const named = (id: number): string => `c-${String(id)}`;

function single({ build, decision, drop }: Next = {}): NextStep | undefined {
  const steps: NextStep[] = [
    ...(build === undefined ? [] : [{ build }]),
    ...(decision === undefined ? [] : [{ decision }]),
    ...(drop === undefined ? [] : [{ drop }]),
  ];
  return steps.length === 1 ? steps[0] : undefined;
}

const refusal = (route: "build" | "decision", id: number, why: string): Error =>
  new Error(`next ${route}=${String(id)}: ${why}`);

function nameCard(db: DatabaseSync, session: Session, route: "build" | "decision", id: number) {
  try {
    return reachable(db, session, id).card;
  } catch (error) {
    throw refusal(route, id, error instanceof Error ? error.message : String(error));
  }
}

function requireBuild(db: DatabaseSync, session: Session, id: number): void {
  const { kind, status } = nameCard(db, session, "build", id);
  const card = named(id);
  if (kind !== "ship")
    throw refusal(
      "build",
      id,
      `${card} is a ${kind} card, so it cannot carry a build: name a ship card`,
    );
  if (status === "dropped")
    throw refusal(
      "build",
      id,
      `${card} is dropped, so it carries no build: name the card that does`,
    );
}

function requireDecision(db: DatabaseSync, session: Session, id: number): void {
  const { kind, status } = nameCard(db, session, "decision", id);
  const card = named(id);
  if (status === "done" || status === "dropped")
    throw refusal("decision", id, `${card} is ${status}: a decision needs an open card`);
  const waitsOnCaptain = factsFrom(cardEntries(db, id)).hold?.holder === "captain";
  if (!waitsOnCaptain && kind !== "captain")
    throw refusal(
      "decision",
      id,
      `${card} has no hold that waits on the captain and is not a captain-only card. Put the decision on a captain-only card (card_new) and hold it for him, then name that card`,
    );
}

export function requireNext(
  db: DatabaseSync,
  session: Session,
  card: Card,
  mode: "done" | "dropped",
  next: Next | undefined,
): NextStep | undefined {
  const name = named(card.id);
  if (card.kind !== "scout" || mode === "dropped") {
    if (next === undefined) return undefined;
    const what = mode === "dropped" ? "ending Dropped" : `a ${card.kind} card`;
    throw new Error(`${name} is ${what}: next goes only with the Done close of a scout`);
  }
  const step = single(next);
  if (step === undefined)
    throw new Error(
      `${name} is a scout: it closes Done only when the close says what happens next. ${ROUTES_HELP}`,
    );
  if ("build" in step) requireBuild(db, session, step.build);
  if ("decision" in step) requireDecision(db, session, step.decision);
  return step;
}

export function nextLine(step: NextStep): string {
  if ("build" in step) return `Next: ${named(step.build)} carries the build.`;
  if ("decision" in step) return `Next: the captain decides on ${named(step.decision)}.`;
  return `Next: nothing is built, because ${step.drop.trim().replace(/[.!]+$/, "")}.`;
}
