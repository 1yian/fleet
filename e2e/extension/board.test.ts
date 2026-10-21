// A mate reads the fleet with its tools, never with sqlite: the board shows the live cards and
// counts the closed ones, and the card tool shows one card's hold, attempts, and thread. Both
// print TOON with counts, cut text, explicit empty states, and next steps (https://axi.md).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let h: Harness;
beforeEach(async () => {
  fleet = await startFleet();
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);

type Args = Readonly<Record<string, string | number | boolean>>;

/** Starts main's Pi, has it make each tool call in turn, and returns what each call printed. */
async function mainCalls(calls: readonly (readonly [string, Args])[]): Promise<string[]> {
  for (const [tool, args] of calls) h.onModel(() => ({ tool, args }));
  h.onModel(() => ({ text: "read" }));
  const env = { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: fleet.mainToken, FLEET_ROLE: "mate" };
  const mate = h.startPi("main", env, [EXTENSION]);
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("What is on the board?");
  return toolResults(await h.waitForCall(calls.length));
}

const LONG_NOTE = `${"The scrollbar doubles because the panel and the page both scroll. ".repeat(6)}Report written: /tmp/scrollbar-report.md.`;

/**
 * c-1 is cleo's lane card. c-2 waits on the captain, c-3 has a worker on it, c-4 is queued,
 * c-5 is done, c-6 is dropped, and c-7 is cleo's card with a question for main.
 */
async function seed(): Promise<{ cleo: Session; worker: Session }> {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const { main } = fleet;
  const api = await newCard(main, "Pick the API version", "captain");
  await main.call("hold", { card: api.id, question: "v1 or v2?", options: ["v2", "v1"] });
  const scroll = await newCard(main, "Fix the scrollbar");
  const worker = await fleet.cardd.connect(await begin(main, scroll, "Fix the double scrollbar"));
  await worker.call("report", { status: "working", text: LONG_NOTE });
  await newCard(main, "Write the docs");
  for (const [title, mode] of [
    ["Ship the logo", "done"],
    ["Try the old banner", "dropped"],
  ] as const) {
    const card = await newCard(main, title, "scout");
    await main.call("close.finish", { card: card.id, mode, text: title, archives: [], left: [] });
  }
  const ads = check(
    OPS["card.new"].result,
    await cleo.call("card.new", { title: "Pick an ad channel", kind: "scout" }),
  );
  await cleo.call("hold", { card: ads.id, question: "Search or social?" });
  return { cleo, worker };
}

test("board shows the open cards by what needs attention, and counts the closed ones", async () => {
  const sessions = await seed();
  const [board] = await mainCalls([["board", {}]]);
  assert.equal(
    board,
    [
      'open: "5 (needs-you 1, with-mate 1, working 1, queued 1, waiting 1)"',
      'closed: "2 (done 1, dropped 1)"',
      "cards[5]{card,status,waits,title}:",
      "  2,needs-you,captain,Pick the API version",
      "  7,with-mate,main,Pick an ad channel",
      "  3,working,worker,Fix the scrollbar",
      "  4,queued,main,Write the docs",
      "  1,waiting,cleo,cleo",
      "help[3]:",
      "  Call `card(card=<card>)` to read a card: its hold, PR, branch, and thread",
      '  Call `board(status="closed")` to list the newest closed cards',
      '  Call `board(fields="lane,pr")` for more columns: name, lane, kind, project, pr, summary, updated',
    ].join("\n"),
  );
  await Promise.all([sessions.cleo.close(), sessions.worker.close()]);
});

test("board filters by status and lane, caps the closed cards, adds fields, and refuses an unknown one", async () => {
  const sessions = await seed();
  const [dropped, cleo, capped, fields, unknown] = await mainCalls([
    ["board", { status: "dropped" }],
    ["board", { lane: "cleo" }],
    ["board", { status: "closed", limit: 1 }],
    ["board", { status: "working", fields: "lane,summary" }],
    ["board", { fields: "owner" }],
  ]);
  assert.match(
    dropped ?? "",
    /^cards\[1\]\{card,status,waits,title\}:\n {2}6,dropped,nobody,Try the old banner$/m,
  );
  assert.equal(
    cleo,
    [
      "lane: cleo",
      'open: "2 (with-mate 1, waiting 1)"',
      "closed: 0",
      "cards[2]{card,status,waits,title}:",
      "  7,with-mate,main,Pick an ad channel",
      "  1,waiting,cleo,cleo",
      "help[2]:",
      "  Call `card(card=<card>)` to read a card: its hold, PR, branch, and thread",
      '  Call `board(fields="lane,pr")` for more columns: name, lane, kind, project, pr, summary, updated',
    ].join("\n"),
  );
  assert.match(capped ?? "", /^hidden: 1 older closed cards$/m);
  assert.match(capped ?? "", /^cards\[1\]\{card,status,waits,title\}:$/m);
  assert.match(
    capped ?? "",
    /^ {2}Call `board\(status="closed", limit=<n>\)` to list more closed cards$/m,
  );
  assert.match(
    fields ?? "",
    /^cards\[1\]\{card,status,waits,title,lane,summary\}:\n {2}3,working,worker,Fix the scrollbar,main,"The scrollbar doubles because/m,
  );
  assert.equal(
    unknown,
    [
      "error: unknown field owner",
      "help[1]:",
      "  Call `board(fields=<fields>)` with fields from: name, lane, kind, project, pr, summary, updated",
    ].join("\n"),
  );
  await Promise.all([sessions.cleo.close(), sessions.worker.close()]);
});

test("an empty board says so", async () => {
  const [board, lane] = await mainCalls([
    ["board", {}],
    ["board", { lane: "cleo", status: "all" }],
  ]);
  assert.equal(board, "open: 0\nclosed: 0\ncards: 0 open cards");
  assert.equal(lane, "lane: cleo\nopen: 0\nclosed: 0\ncards: 0 cards in lane cleo");
});

test("card shows one card's hold, attempt, report, and thread, cut until full", async () => {
  const sessions = await seed();
  const [scroll, whole, api, missing] = await mainCalls([
    ["card", { card: 3 }],
    ["card", { card: 3, full: true, entries: 1 }],
    ["card", { card: 2 }],
    ["card", { card: 99 }],
  ]);
  const view = scroll ?? "";
  assert.match(
    view,
    /^card:\n {2}id: 3\n {2}name: fix-the-scrollbar\n {2}title: Fix the scrollbar\n {2}kind: ship\n {2}project: web\n {2}lane: main\n {2}status: working\n {2}waits: worker\n {2}pr: none\n/,
  );
  assert.match(view, /^attempts\[1\]\{n,host,state,branch\}:\n {2}1,maverick,active,\S*c-3-a1$/m);
  assert.match(view, /^report: \/tmp\/scrollbar-report\.md$/m);
  assert.doesNotMatch(view, /^(hold|intent|spec):/m);
  // Newest first: the worker's note, cut with its size, then the task message.
  assert.match(
    view,
    /^entries\[2\]\{id,age,from,kind,body\}:\n {2}\d+,\d+s ago,"worker:c-3-a1",report\/working,"The scrollbar doubles[^"\n]*\.\.\. \(truncated, 437 chars total, full=true shows all\)"\n {2}\d+,\d+s ago,"mate:main",comment,Fix the double scrollbar$/m,
  );
  assert.match(view, /^ {2}Call `card\(card=3, full=true\)` to see every text whole$/m);

  // full shows the whole text, and entries=1 hides the older entry and says how to see it.
  assert.ok((whole ?? "").includes(LONG_NOTE));
  assert.match(whole ?? "", /^hidden: 1 older entries$/m);
  assert.match(whole ?? "", /^ {2}Call `card\(card=3, entries=2\)` to read the whole thread$/m);

  assert.match(
    api ?? "",
    /^hold:\n {2}waits: captain\n {2}question: v1 or v2\?\n {2}options\[2\]: v2,v1$/m,
  );
  assert.match(api ?? "", /^attempts: 0 \(never dispatched\)$/m);
  // Nothing on it was cut, so it offers no full view.
  assert.doesNotMatch(api ?? "", /full=true/);
  assert.equal(missing, "error: no card c-99\nhelp[1]:\n  Call `board()` to list the open cards");
  await Promise.all([sessions.cleo.close(), sessions.worker.close()]);
});

test("projects lists the registry in TOON with its count", async () => {
  const [projects] = await mainCalls([["projects", {}]]);
  assert.equal(
    projects,
    [
      "count: 1",
      "projects[1]{name,delivery,base,hosts}:",
      "  web,no-mistakes,main,maverick p620",
      "help[1]:",
      "  Call `card_new(title=<title>, kind=<kind>, project=<name>)` to start work on one",
    ].join("\n"),
  );
});
