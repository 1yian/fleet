// A small fleet on a real cardd: a main lane, a card, and a worker on it.
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "./cardd.ts";

export interface Fleet {
  readonly cardd: Cardd;
  readonly mainToken: string;
  readonly main: Session;
}

export async function startFleet(): Promise<Fleet> {
  const cardd = await Cardd.start();
  const mainToken = cardd.addLane("main");
  return { cardd, mainToken, main: await cardd.connect(mainToken) };
}

export async function newCard(
  mate: Session,
  title: string,
  kind: Card["kind"] = "ship",
): Promise<Card> {
  return check(CardSchema, await mate.call("card.new", { title, kind }));
}

/** Dispatches a worker on the card. Returns its token. */
export async function begin(mate: Session, card: Card): Promise<string> {
  const value = await mate.call("attempt.begin", { card: card.id, host: "maverick" });
  return check(OPS["attempt.begin"].result, value).token;
}

export async function status(mate: Session, card: Card): Promise<Card["status"]> {
  const cards = check(OPS.board.result, await mate.call("board", {}));
  const found = cards.find((each) => each.id === card.id);
  if (found === undefined) throw new Error(`card ${String(card.id)} is not on the board`);
  return found.status;
}
