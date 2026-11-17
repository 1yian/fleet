import type { DatabaseSync } from "node:sqlite";
import type { Card, Next } from "@fleet/protocol";
import { getCard, parentOf, reachable, type Session } from "./store.ts";

export type NextStep =
  | { readonly build: number }
  | { readonly decision: number }
  | { readonly delivered: NonNullable<Next["delivered"]> }
  | { readonly drop: string };

const ROUTES_HELP =
  "Pass next with exactly one of build=<number of a ship card that carries the build, open or Done>, decision=<number of an open card whose hold waits on the captain>, drop=<why nothing is built>, or delivered={evidence, disposition} for findings read or relayed that complete the request with no authorized build or unresolved decision left. Build directly when the captain already asked for the thing built, put a build-or-drop decision to him when he asked only for a plan, and drop when the findings make it moot";

const named = (id: number): string => `c-${String(id)}`;

function single({ build, decision, drop, delivered }: Next = {}): NextStep | undefined {
  const steps: NextStep[] = [
    ...(build === undefined ? [] : [{ build }]),
    ...(decision === undefined ? [] : [{ decision }]),
    ...(drop === undefined ? [] : [{ drop }]),
    ...(delivered === undefined ? [] : [{ delivered }]),
  ];
  return steps.length === 1 ? steps[0] : undefined;
}

const refusal = (route: "build" | "decision", id: number, why: string): Error =>
  new Error(`next ${route}=${String(id)}: ${why}`);

function nameable(db: DatabaseSync, session: Session, id: number): Card {
  const card = getCard(db, id);
  if (card.lane === parentOf(db, session.lane)) return card;
  try {
    return reachable(db, session, id).card;
  } catch {
    throw new Error(
      `c-${String(id)} belongs to lane ${card.lane}: a close names a card of its own lane, of a lane below it, or of the lane above it`,
    );
  }
}

function nameCard(db: DatabaseSync, session: Session, route: "build" | "decision", id: number) {
  try {
    return nameable(db, session, id);
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
  const { status } = nameCard(db, session, "decision", id);
  const card = named(id);
  if (status === "done" || status === "dropped")
    throw refusal("decision", id, `${card} is ${status}: a decision needs an open card`);
  if (status !== "needs-you")
    throw refusal(
      "decision",
      id,
      `${card} has no hold that waits on the captain now. Hold it first: card_new for the decision if no card carries it, then hold(card, question, options) for the captain (a second mate holds it for main, and main escalates it with to=captain), then name that card`,
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
  if ("delivered" in step)
    return `Delivered: ${step.delivered.evidence}\nDisposition: ${step.delivered.disposition}`;
  return `Next: nothing is built, because ${step.drop.trim().replace(/[.!]+$/, "")}.`;
}
