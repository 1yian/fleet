import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { CardSchema, check, MERGE_OPTIONS, OPS, type Card } from "@fleet/protocol";
import type { Cardd, Session } from "./cardd.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface Kanban {
  readonly cardd: Cardd;
  readonly main: Session;
  readonly cleo: Session;
  readonly leo: Session;
  readonly cards: Readonly<Record<string, Card>>;
}

const pr = (repo: string, n: number): string => `https://github.com/acme/${repo}/pull/${String(n)}`;

const newShip = async (mate: Session, title: string, project: string): Promise<Card> =>
  check(CardSchema, await mate.call("card.new", { title, kind: "ship", project }));

async function ship(
  cardd: Cardd,
  mate: Session,
  title: string,
  project: string,
): Promise<{ card: Card; worker: Session }> {
  const card = await newShip(mate, title, project);
  const begin = await mate.call("attempt.begin", { card: card.id, host: "maverick", task: title });
  const { token } = check(OPS["attempt.begin"].result, begin);
  return { card, worker: await cardd.connect(token) };
}

function merge(cardd: Cardd, url: string): void {
  execFileSync("gh", ["pr", "merge", url, "--squash"], {
    env: { ...process.env, ...cardd.gh.env },
  });
}

async function ready(cardd: Cardd, card: Card, worker: Session, url: string): Promise<void> {
  cardd.gh.setPr(url, "OPEN", { ci: "pass" });
  cardd.gh.setHead(url, `c-${String(card.id)}-a1`);
  await worker.call("report", { status: "done", text: "PR green and ready" });
}

async function landed(cardd: Cardd, mate: Session, card: Card, worker: Session, url: string) {
  merge(cardd, url);
  await worker.call("report", { status: "done", text: `merged ${url}` });
  await mate.waitForEntry(
    (entry) => entry.card === card.id && entry.fields["condition"] === "pr-merged",
    "the merged notice",
  );
  await mate.call("close.finish", {
    card: card.id,
    mode: "done",
    text: "Merged and closed.",
    archives: [],
    left: [],
  });
}

function closeLongAgo(cardd: Cardd, card: Card, ms: number, text: string): void {
  const db = new DatabaseSync(cardd.db);
  db.prepare(
    "INSERT INTO entries (card, author, kind, body, fields, created_at) VALUES (?, 'mate:main', 'cleanup', ?, ?, ?)",
  ).run(
    card.id,
    text,
    JSON.stringify({ outcome: "done", archives: [], left: [] }),
    Date.now() - ms,
  );
  db.close();
}

type Cards = Record<string, Card>;

async function seedOpen(
  cardd: Cardd,
  main: Session,
  cleo: Session,
  leo: Session,
  cards: Cards,
): Promise<void> {
  cards["queued"] = await newShip(main, "Board: kanban columns from card status", "fleet");
  cards["leoQueued"] = await newShip(leo, "Leo: rotate the Twilio webhook secret", "calls");
  cards["later"] = check(
    CardSchema,
    await leo.call("card.new", { title: "Renew the leo-calls TLS certificate", kind: "scout" }),
  );
  await leo.call("hold", {
    card: cards["later"].id,
    question: "Renew the certificate on Thursday?",
    until: Date.now() + 3 * DAY,
  });

  const working = await ship(
    cardd,
    main,
    "Short fleet messages: one line, details on the card",
    "fleet",
  );
  await working.worker.call("report", { status: "working", text: "reading the message code" });
  cards["working"] = working.card;
  const review = await ship(
    cardd,
    main,
    "Ban comments in code: a lint rule fails on any comment",
    "fleet",
  );
  await review.worker.call("report", { status: "in-review", text: "validating" });
  cards["review"] = review.card;
  const blocked = await ship(
    cardd,
    cleo,
    "Cleo: merge duplicate leads from the nightly import",
    "calls",
  );
  await blocked.worker.call("report", {
    status: "needs-decision",
    key: "dupes",
    text: "Merge on email only, or email and phone?",
  });
  cards["withMate"] = blocked.card;

  const mergeAsk = await ship(cardd, main, "Board: thread as a story, steers fold away", "fleet");
  await ready(cardd, mergeAsk.card, mergeAsk.worker, pr("fleet", 39));
  cards["merge"] = mergeAsk.card;
  cards["question"] = check(
    CardSchema,
    await main.call("card.new", {
      title: "Vehicle acquisition: a passed lead stops Cleo's emails",
      kind: "captain",
    }),
  );
  await main.call("hold", {
    card: cards["question"].id,
    question:
      "Review found 2 bugs: F-450s count as work trucks, and a race emails passed leads. Both are small. Fixing both adds a day, and R2 is already fixed in the open PR, so the extra work is R1 only.",
    options: ["Fix both", "Fix R1 only", "Ship as is"],
  });
  cards["simple"] = check(
    CardSchema,
    await main.call("card.new", { title: "Pick the API version", kind: "captain" }),
  );
  await main.call("hold", {
    card: cards["simple"].id,
    question: "Which API version ships?",
    options: ["v1", "v2"],
  });

  const approved = await ship(
    cardd,
    main,
    "Memory e2e expects fleet messages labelled once",
    "fleet",
  );
  await ready(cardd, approved.card, approved.worker, pr("fleet", 36));
  await main.call("release", {
    card: approved.card.id,
    words: "yes, merge it",
    source: "chat",
    choice: MERGE_OPTIONS[0],
  });
  cards["approved"] = approved.card;
  const auto = await ship(cardd, leo, "Leo: let date of birth be used on a call", "calls");
  await ready(cardd, auto.card, auto.worker, pr("calls", 12));
  cards["auto"] = auto.card;
}

async function seedClosed(cardd: Cardd, main: Session, leo: Session, cards: Cards): Promise<void> {
  const merged = await ship(cardd, main, "Workers start on Pi's default model", "fleet");
  await ready(cardd, merged.card, merged.worker, pr("fleet", 34));
  await main.call("release", {
    card: merged.card.id,
    words: "yes, merge it",
    source: "chat",
    choice: MERGE_OPTIONS[0],
  });
  await landed(cardd, main, merged.card, merged.worker, pr("fleet", 34));
  cards["merged"] = merged.card;
  const automatic = await ship(cardd, leo, "Leo: ship the call recording banner", "calls");
  await ready(cardd, automatic.card, automatic.worker, pr("calls", 11));
  await landed(cardd, leo, automatic.card, automatic.worker, pr("calls", 11));
  cards["automatic"] = automatic.card;
  cards["scout"] = check(
    CardSchema,
    await main.call("card.new", { title: "Scope a Linear-style board", kind: "scout" }),
  );
  await main.call("close.finish", {
    card: cards["scout"].id,
    mode: "done",
    text: "Scoped.",
    archives: [],
    left: [],
  });
  cards["old"] = check(
    CardSchema,
    await main.call("card.new", { title: "Migrate the live cardd", kind: "scout" }),
  );
  closeLongAgo(cardd, cards["old"], 3 * DAY, "Migrated.");
  cards["dropped"] = check(
    CardSchema,
    await main.call("card.new", { title: "Try the dock", kind: "scout" }),
  );
  await main.call("close.finish", {
    card: cards["dropped"].id,
    mode: "dropped",
    text: "Cut from the plan.",
    archives: [],
    left: [],
  });
}

export async function seedKanban(cardd: Cardd, main: Session): Promise<Kanban> {
  cardd.addProject("fleet", { maverick: "/clones/fleet" }, "acme/fleet");
  cardd.addProject("calls", { maverick: "/clones/calls" }, "acme/calls");
  cardd.yolo("calls");
  const cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  const leo = await cardd.connect(cardd.addLane("leo", "main"));
  const cards: Record<string, Card> = {};

  await seedOpen(cardd, main, cleo, leo, cards);
  await seedClosed(cardd, main, leo, cards);
  return { cardd, main, cleo, leo, cards };
}
