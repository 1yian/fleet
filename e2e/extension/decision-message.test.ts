import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { CardSchema, check, OPS, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { Harness, type Move, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const PR = "https://github.com/acme/web/pull/7";
const PAGE = "https://review.example/session/abc";
const NEEDS_YOU_ROW = "the card is now `needs-you`";
const REMINDER_ROW = "reminder: N cards need a decision or action from you";
const STAYS_SILENT = /silent|not message him|not announce|waits? on (the|his) board/i;

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

function lineOf(contract: string, start: string): string {
  const lines = contract.split("\n").filter((line) => line.startsWith(start));
  assert.equal(lines.length, 1, `the contract has one line that starts with ${start}`);
  return lines[0] ?? "";
}

function interruptionsOf(contract: string): string {
  const from = contract.indexOf("- **Exactly four interruptions.**");
  const to = contract.indexOf("- Use the captain's nouns");
  assert.ok(from >= 0 && to > from, "the contract has the four interruptions");
  return contract.slice(from, to);
}

type Expectation = readonly [name: string, holds: boolean];

function expectAll(expectations: readonly Expectation[]): void {
  const broken = expectations.filter(([, holds]) => !holds).map(([name]) => name);
  assert.deepEqual(broken, [], "the contract lines that are wrong");
}

async function startMain(escalate?: (card: number) => Move): Promise<void> {
  const { cardd, h } = lab();
  for (let call = 0; call < 12; call += 1)
    h.onModel((turns) =>
      call === 0 && escalate !== undefined
        ? escalate(Number(/\bc-(\d+)\b/.exec(textOf(turns, "user"))?.[1]))
        : { tool: "yield" },
    );
  h.startPi("main", { FLEET_URL: cardd.url, FLEET_TOKEN: mainToken, FLEET_ROLE: "mate" }, [
    EXTENSION,
  ]);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");
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
  readonly names: readonly [what: string, shown: RegExp][];
  readonly escalate?: (card: number) => Move;
  readonly arrive: () => Promise<void>;
}[] = [
  {
    name: "the merge question on main's own ship card",
    row: NEEDS_YOU_ROW,
    link: PR,
    names: [
      ["chat", /in chat/],
      ["the full PR URL", /full PR URL/],
    ],
    arrive: async () => {
      const [, worker] = await shipCard(asMain);
      await worker.call("report", { status: "done", text: "PR green and ready", pr: PR });
    },
  },
  {
    name: "a second mate's merge question that main escalates",
    row: "`[fleet] fleet on c-N (hold): Merge`",
    link: PR,
    names: [
      ["chat", /in chat/],
      ["the full PR URL", /full PR URL/],
    ],
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
    names: [],
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
    names: [["the page's link", /its link/]],
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
  test(`main is told to put the decision to the captain in chat once when ${arrival.name} arrives`, async () => {
    await startLab();
    await startMain(arrival.escalate);
    await arrival.arrive();

    const turns = await lab().h.waitForCall(0);
    assert.ok(textOf(turns, "user").includes(arrival.link), "the notification carries the link");
    const row = rowOf(textOf(turns, "system"), arrival.row);
    expectAll([
      ["the row tells main to put it to the captain once", row.includes("to the captain once")],
      [
        "the row points main at section 8, where a decision is a chat message",
        row.includes("(section 8)"),
      ],
      ...arrival.names.map(([what, shown]): Expectation => [
        `the row names ${what}`,
        shown.test(row),
      ]),
      ["the row never says to stay silent about it", !STAYS_SILENT.test(row)],
    ]);

    if (arrival.escalate !== undefined) {
      await lab().h.waitForCall(1);
      assert.equal(
        (await lab().cardd.board()).holds.length,
        1,
        "the decision is also a hold on the captain's board",
      );
    }
  });
}

const ROUTINE: readonly {
  readonly name: string;
  readonly row: string;
  readonly says: RegExp;
  readonly arrive: () => Promise<void>;
}[] = [
  {
    name: "a second mate's finished card",
    row: "`[fleet] <lane> on c-N (close):`",
    says: /do not relay it/,
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
    says: /Tell the captain nothing/,
    arrive: async () => {
      lab().cardd.yolo("web");
      const [, worker] = await shipCard(asMain);
      await worker.call("report", { status: "done", text: "PR green and ready", pr: PR });
    },
  },
];

for (const routine of ROUTINE) {
  test(`main is still told to say nothing to the captain when ${routine.name} arrives`, async () => {
    await startLab();
    await startMain();
    await routine.arrive();

    const turns = await lab().h.waitForCall(0);
    const row = rowOf(textOf(turns, "system"), routine.row);
    expectAll([
      ["the row tells main to say nothing about it", routine.says.test(row)],
      ["the row never tells main to put it to the captain", !row.includes("to the captain once")],
    ]);
  });
}

test("the reminder that lists a decision tells main not to say it again, in its row and in its text", async () => {
  await startLab("0.01");
  await startMain();
  const [, worker] = await shipCard(asMain);
  await worker.call("report", { status: "done", text: "PR green and ready", pr: PR });

  let turns = await lab().h.waitForCall(0);
  for (let call = 1; !/reminder:.*Waiting on the captain/s.test(textOf(turns, "user")); call += 1)
    turns = await lab().h.waitForCall(call, "default", 60_000);

  const row = rowOf(textOf(turns, "system"), REMINDER_ROW);
  expectAll([
    ["the row says not to say a waiting decision again", /do not say it again/i.test(row)],
    ["the row says not to list the decisions", /do not list them/i.test(row)],
    [
      "the reminder's text says not to say it again",
      /do not say it again/i.test(textOf(turns, "user")),
    ],
  ]);
});

async function contractOf(lane: string, token: string): Promise<string> {
  const { cardd, h } = lab();
  h.onModel(() => ({ text: "aye" }));
  h.startPi(lane, { FLEET_URL: cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "mate" }, [
    EXTENSION,
  ]).prompt("Good morning.");
  const turns = await h.waitForCall(0);
  const contract = textOf(turns, "system");
  assert.ok(/^# Firstmate$/m.test(contract), "the mate received its role contract");
  return contract;
}

test("main's contract says a decision for the captain is one message, said once, and does not yield", async () => {
  await startLab();
  const contract = await contractOf("main", mainToken);
  const yielding = lineOf(contract, "- `yield()` ends your turn silently");
  const interruptions = interruptionsOf(contract);
  expectAll([
    [
      "section 3 names putting a decision to him as a turn that does not yield",
      yielding.includes("unless the turn puts a decision to him"),
    ],
    [
      "section 3 never lets yield skip a decision for him",
      yielding.includes("a decision for him among them"),
    ],
    [
      "section 8 lists a decision arriving as the fourth interruption",
      /^\s*4\. A decision arrives for him/m.test(interruptions),
    ],
    [
      "section 8 says to say it when it arrives",
      interruptions.includes("Say it when it arrives, not later"),
    ],
    [
      "section 8 gives the message its evidence, consequence, recommendation, and full PR URL",
      interruptions.includes(
        "what he is asked, the evidence, the consequence, your recommendation, and the full PR URL when there is one",
      ),
    ],
    [
      "section 8 says a decision is said once and not again in a reminder",
      interruptions.includes(
        "a decision is said once, when it arrives, and never again in a reminder",
      ),
    ],
    [
      "section 8 never lets a decision end in yield",
      contract.includes(
        "A decision for him is not routine: write its message, and do not yield instead",
      ),
    ],
  ]);
});

for (const [lane, who] of [
  ["main", "main"],
  ["dana", "a second mate"],
] as const) {
  test(`${who} is never told to say /d, so chat never tells the captain how to open the card`, async () => {
    await startLab();
    const token = lane === "main" ? mainToken : lab().cardd.addLane("dana", "main");
    const contract = await contractOf(lane, token);

    assert.deepEqual(contract.match(/.{0,100}\/d\b.{0,60}/g) ?? [], []);
  });
}
