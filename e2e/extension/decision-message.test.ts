import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Move, type Turn } from "../support/harness.ts";
import { isRecord, messageText, optionalString, parseRecord } from "../support/json.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const PR = "https://github.com/acme/web/pull/7";
const PAGE = "https://review.example/session/abc";
const PUTS_TO_THE_CAPTAIN = "to the captain once";
const NEEDS_YOU_ROW = "the card is now `needs-you`";
const REMINDER_ROW = "reminder: N cards need a decision or action from you";

let cardd: Cardd | undefined;
let h: Harness | undefined;
let cleo: Session | undefined;
let mainToken = "";

async function startLab(timing = "1"): Promise<void> {
  cardd = await Cardd.start({ CARDD_TIMING_SCALE: timing });
  cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
  mainToken = cardd.addLane("main");
  cleo = await cardd.connect(cardd.addLane("cleo", "main"));
  h = await Harness.start();
}

afterEach(async () => {
  const stopped = await Promise.allSettled([cleo?.close(), h?.stop(), cardd?.stop()]);
  cleo = h = cardd = undefined;
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const lab = (): { cardd: Cardd; h: Harness; cleo: Session } => {
  if (cardd === undefined || h === undefined || cleo === undefined) throw new Error("no lab");
  return { cardd, h, cleo };
};

type Ops = (op: string, args: unknown) => Promise<unknown>;

async function asMain(op: string, args: unknown): Promise<unknown> {
  const { status, body } = await lab().cardd.post(mainToken, op, args);
  assert.equal(status, 200, JSON.stringify(body));
  return Reflect.get(Object(body), "value");
}
const asCleo: Ops = (op, args) => lab().cleo.call(op, args);

async function shipCard(ops: Ops, kind: Card["kind"] = "ship"): Promise<[Card, Session]> {
  const card = check(
    CardSchema,
    await ops("card.new", { title: "Scrollbar fix", kind, project: "web" }),
  );
  const begun = check(
    OPS["attempt.begin"].result,
    await ops("attempt.begin", { card: card.id, host: "maverick", task: "the task" }),
  );
  return [card, await lab().cardd.connect(begun.token)];
}

function rowOf(contract: string, marker: string): string {
  const rows = contract
    .split("\n")
    .filter((line) => line.startsWith("| `[fleet]") && line.includes(marker));
  assert.equal(rows.length, 1, `the contract has one row for ${marker}`);
  return rows[0] ?? "";
}

const textOf = (turns: Turn[], role: string): string =>
  turns.findLast((turn) => turn.role === role)?.text ?? "";

type Rule = readonly [message: RegExp, row: string];

function mateFollowingRows(
  rules: readonly Rule[],
  escalate?: (card: number) => Move,
): (turns: Turn[]) => Move {
  return (turns) => {
    const message = textOf(turns, "user");
    const row = rules.find(([when]) => when.test(message))?.[1];
    if (row === undefined || !rowOf(textOf(turns, "system"), row).includes(PUTS_TO_THE_CAPTAIN))
      return { tool: "yield" };
    if (escalate !== undefined && turns.at(-1)?.role === "user")
      return escalate(Number(/\bc-(\d+)\b/.exec(message)?.[1]));
    const link = /https:\/\/[^\s)]+/.exec(message)?.[0] ?? "";
    return { text: `The work is ready for your review: ${link}. Merge it? I recommend yes.` };
  };
}

async function startMain(handler: (turns: Turn[]) => Move): Promise<void> {
  const { cardd, h } = lab();
  for (let call = 0; call < 12; call += 1) h.onModel(handler);
  h.startPi("main", { FLEET_URL: cardd.url, FLEET_TOKEN: mainToken, FLEET_ROLE: "mate" }, [
    EXTENSION,
  ]);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");
}

async function chatAfterTurn(turn = 1): Promise<string[]> {
  const { h } = lab();
  const settled = await h.waitForNth(
    (event) => event["type"] === "settled",
    turn,
    "main to settle",
  );
  assert.equal(settled["aborted"], false);
  const session = await h.waitFor((event) => event["type"] === "session", "the session file");
  return readFileSync(optionalString(session, "file") ?? "", "utf8")
    .split("\n")
    .filter(Boolean)
    .map(parseRecord)
    .map((entry) => entry["message"])
    .filter(isRecord)
    .filter((message) => message["role"] === "assistant")
    .map(messageText)
    .filter((text) => text !== "");
}

const holdFor =
  (question: string) =>
  (card: number): Move => ({
    tool: "hold",
    args: { card, question },
  });
const escalate =
  (question: string) =>
  (card: number): Move => ({
    tool: "hold",
    args: { card, to: "captain", question },
  });

const ARRIVALS: readonly {
  readonly name: string;
  readonly row: string;
  readonly link: string;
  readonly escalate?: (card: number) => Move;
  readonly arrive: () => Promise<void>;
}[] = [
  {
    name: "the merge question on main's own ship card",
    row: NEEDS_YOU_ROW,
    link: PR,
    arrive: async () => {
      const [, worker] = await shipCard(asMain);
      await worker.call("report", { status: "done", text: "PR green and ready", pr: PR });
    },
  },
  {
    name: "a second mate's merge question that main escalates",
    row: "`[fleet] fleet on c-N (hold): Merge`",
    link: PR,
    escalate: escalate(`Merge ${PR}? It fixes the scrollbar.`),
    arrive: async () => {
      const [, worker] = await shipCard(asCleo);
      await worker.call("report", { status: "done", text: "PR green and ready", pr: PR });
    },
  },
  {
    name: "a second mate's hold that main escalates",
    row: "`[fleet] <lane> on c-N (hold):`",
    link: PR,
    escalate: escalate(`Ship ${PR} before the freeze? I recommend yes.`),
    arrive: async () => {
      const [card] = await shipCard(asCleo);
      await lab().cleo.call("hold", {
        card: card.id,
        question: `Ship ${PR} before the freeze?`,
      });
    },
  },
  {
    name: "a review page that needs the captain",
    row: "`[fleet] c-N needs-decision [review-J]:`",
    link: PAGE,
    escalate: holdFor(`Review the page: ${PAGE}`),
    arrive: async () => {
      const [, worker] = await shipCard(asMain);
      await worker.call("report", {
        status: "needs-decision",
        key: "review-1",
        text: `Review ready: ${PAGE}`,
      });
    },
  },
];

for (const arrival of ARRIVALS) {
  test(`main writes one chat message with the link when ${arrival.name} arrives, and does not yield`, async () => {
    await startLab();
    await startMain(mateFollowingRows([[/./, arrival.row]], arrival.escalate));
    await arrival.arrive();

    const chat = await chatAfterTurn();
    assert.equal(chat.length, 1, `one message: ${JSON.stringify(chat)}`);
    assert.ok(chat[0]?.includes(arrival.link), "the message carries the full link");
    assert.doesNotMatch(chat[0] ?? "", /\/d\b/);
    assert.equal(lab().h.callsOf("default").length, arrival.escalate === undefined ? 1 : 2);
    if (arrival.escalate !== undefined)
      assert.equal(
        (await lab().cardd.board()).holds.length,
        1,
        "the decision is also a hold on the captain's board",
      );
  });
}

const ROUTINE: readonly {
  readonly name: string;
  readonly row: string;
  readonly arrive: () => Promise<void>;
}[] = [
  {
    name: "a second mate's finished card",
    row: "`[fleet] <lane> on c-N (close):`",
    arrive: async () => {
      const [card, worker] = await shipCard(asCleo, "scout");
      await worker.call("report", { status: "done", text: "report written" });
      await lab().cleo.call("close.finish", {
        card: card.id,
        mode: "done",
        text: "Search ads convert best.",
        next: { drop: "nothing to build" },
        archives: [],
        left: [],
      });
    },
  },
  {
    name: "a landing that the project's yolo flag authorized",
    row: "the card is now `merging`",
    arrive: async () => {
      lab().cardd.yolo("web");
      const [, worker] = await shipCard(asMain);
      await worker.call("report", { status: "done", text: "PR green and ready", pr: PR });
    },
  },
];

for (const routine of ROUTINE) {
  test(`${routine.name} still ends main's turn silently`, async () => {
    await startLab();
    await startMain(mateFollowingRows([[/./, routine.row]]));
    await routine.arrive();

    assert.deepEqual(await chatAfterTurn(), []);
    assert.equal(lab().h.callsOf("default").length, 1, "yield asks the model for nothing more");
  });
}

test("a reminder that lists the decision after main put it to the captain adds no second message", async () => {
  await startLab("0.01");
  const seen: string[] = [];
  const follow = mateFollowingRows([
    [/needs-you/, NEEDS_YOU_ROW],
    [/reminder:/, REMINDER_ROW],
  ]);
  await startMain((turns) => {
    seen.push(textOf(turns, "user"));
    return follow(turns);
  });
  const [, worker] = await shipCard(asMain);
  await worker.call("report", { status: "done", text: "PR green and ready", pr: PR });
  await chatAfterTurn();

  const reminded = (): boolean =>
    seen.some((message) => /reminder:.*Waiting on the captain/s.test(message));
  const deadline = Date.now() + 60_000;
  while (!reminded()) {
    assert.ok(Date.now() < deadline, `no reminder arrived: ${JSON.stringify(seen)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const chat = await chatAfterTurn(seen.length);
  assert.equal(chat.length, 1, `only the first message: ${JSON.stringify(chat)}`);
  assert.ok(chat[0]?.includes(PR));
});

for (const [lane, who] of [
  ["main", "main"],
  ["dana", "a second mate"],
] as const) {
  test(`${who} is never told to say /d, so chat never tells the captain how to open the card`, async () => {
    await startLab();
    const { cardd, h } = lab();
    h.onModel(() => ({ text: "aye" }));
    h.startPi(
      lane,
      {
        FLEET_URL: cardd.url,
        FLEET_TOKEN: lane === "main" ? mainToken : cardd.addLane("dana", "main"),
        FLEET_ROLE: "mate",
      },
      [EXTENSION],
    ).prompt("Good morning.");
    const turns = await h.waitForCall(0);
    const contract = turns.find((turn) => turn.role === "system")?.text ?? "";

    assert.ok(/^# Firstmate$/m.test(contract), "the mate received its role contract");
    assert.deepEqual(contract.match(/.{0,100}\/d\b.{0,60}/g) ?? [], []);
  });
}
