import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import {
  CAPTAIN_LOG_NAME,
  CardSchema,
  CardViewSchema,
  check,
  HttpOutcomeSchema,
  type HttpOutcome,
} from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { Harness, type Move, type Turn } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { isRecord, messageText, optionalString, parseRecord } from "../support/json.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["ROTATION_EVIDENCE_DIR"];
const OLDER = "Approve the staff-call upload";
const NEWER = "Approve the prod tag policy";
const QUESTIONS: Readonly<Record<string, string>> = {
  [OLDER]: "Ship the synthetic upload to staging today?",
  [NEWER]: "Let platform own the prod tag policy?",
};

const LIST = /^\[fleet\] check on c-\d+ [^\n]*\(finding\): reminder:/;
const DUE = /^- Bring this one up now: c-(\d+) (.+?): (.+)$/gm;

interface Due {
  readonly card: number;
  readonly title: string;
}

let cardd: Cardd;
let h: Harness;
let lab: HerdrLab;
let scratch: Scratch;
let mainToken: string;
let pane: string;
let older = 0;
let newer = 0;
const lists: string[] = [];
const refusals: string[] = [];
const steps: string[] = [];

beforeEach(async () => {
  lists.length = 0;
  refusals.length = 0;
  steps.length = 0;
  lastDue = undefined;
  beforeWriting = undefined;
  cardd = await Cardd.start({ CARDD_TIMING_SCALE: "0.002" });
  h = await Harness.start();
  scratch = new Scratch();
  mainToken = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, mainToken);
  lab = await HerdrLab.start({ ...h.piEnv("mate"), PATH: `${BIN}:${process.env["PATH"] ?? ""}` });
});
afterEach(async (t) => {
  await lab.printIfFailed(t);
  if (EVIDENCE !== undefined) {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, `${t.name.replaceAll(/\W+/g, "-")}.txt`), steps.join("\n\n"));
  }
  const stopped = await Promise.allSettled([lab.stop(), h.stop(), cardd.stop()]);
  scratch.dispose();
  const failed = stopped.find((result) => result.status === "rejected");
  if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
});

const dueIn = (list: string): Due[] =>
  [...list.matchAll(DUE)].map(([, card, title]) => ({ card: Number(card), title: title ?? "" }));

const noneDue = (list: string): boolean => dueIn(list).length === 0;
const dueTitles = (list: string): string[] => dueIn(list).map(({ title }) => title);

function writing(refusal: string): Move {
  const card = Number(/c-(\d+) /.exec(refusal)?.[1]);
  const title = /c-\d+ (.+?) is due:/.exec(refusal)?.[1] ?? "";
  const others = Number(/"\+(\d+) more waiting"/.exec(refusal)?.[1] ?? "0");
  const count = others === 0 ? "" : ` +${String(others)} more waiting.`;
  const text = `Captain, ${title}: ${QUESTIONS[title] ?? ""} I recommend yes.${count}`;
  return { tool: "presented", args: { card }, text };
}

type Style = "writes" | "marks-silently" | "yield-first" | "codemode";

const YIELD = { tool: "yield" } as const;
let lastDue: Due | undefined;
let beforeWriting: (() => Promise<void>) | undefined;

async function afterRefusal(refusal: string): Promise<Move> {
  refusals.push(refusal);
  if (refusal.includes(" is due: ")) return writing(refusal);
  assert.ok(lastDue !== undefined);
  assert.deepEqual(await marksOn(lastDue.card), [], "no mark is written before chat text");
  const title = lastDue.title;
  const hook = beforeWriting;
  beforeWriting = undefined;
  await hook?.();
  return { text: `Captain, ${title}: ${QUESTIONS[title] ?? ""}` };
}

function onList(list: string, style: Style): Move {
  lists.push(list);
  [lastDue] = dueIn(list);
  if (lastDue === undefined || style === "writes") return YIELD;
  const mark = { tool: "presented", args: { card: lastDue.card } };
  if (style === "yield-first") return { ...YIELD, alongside: [mark] };
  if (style === "codemode")
    return {
      tool: "codemode",
      args: {
        code: `await tools.presented({card:${String(lastDue.card)}}); await tools.yield({});`,
      },
    };
  return { ...mark, alongside: [YIELD] };
}

function onMessage(text: string): Move {
  if (text.startsWith("[fleet]")) return YIELD;
  if (/\bafk\b/i.test(text)) return { text: "Captain, you are away: the decisions wait." };
  return { text: "Captain, noted." };
}

function script(style: Style): void {
  const policy = (turns: Turn[]): Move | Promise<Move> => {
    h.onModel(policy, "mate");
    const last = turns.at(-1) ?? { role: "", text: "" };
    steps.push(`${last.role}: ${last.text}`);
    if (last.role !== "toolResult")
      return LIST.test(last.text) ? onList(last.text, style) : onMessage(last.text);
    return last.text.includes("yield refused") ? afterRefusal(last.text) : YIELD;
  };
  h.onModel(policy, "mate");
}

async function asMain(op: string, args: unknown): Promise<HttpOutcome> {
  return check(HttpOutcomeSchema, (await cardd.post(mainToken, op, args)).body);
}

async function holdForCaptain(title: string): Promise<number> {
  const made = await asMain("card.new", { title, kind: "captain" });
  if (!made.ok) throw new Error(made.error);
  const { id: card } = check(CardSchema, made.value);
  const held = await asMain("hold", { card, question: QUESTIONS[title] ?? "" });
  if (!held.ok) throw new Error(held.error);
  return card;
}

async function startWithTwoHolds(style: Style): Promise<void> {
  script(style);
  pane = await startMain(lab, scratch, h);
  await h.waitFor((event) => event["type"] === "fleet_connected", "main to connect");
  older = await holdForCaptain(OLDER);
  newer = await holdForCaptain(NEWER);
}

async function untilAsync<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const until = <T>(read: () => T | undefined, what: string): Promise<T> =>
  untilAsync<T>(() => Promise.resolve(read()), what);

async function marksOn(card: number): Promise<string[]> {
  const view = await asMain("card", { card });
  if (!view.ok) return [];
  return check(CardViewSchema, view.value)
    .entries.filter((entry) => entry.kind === "note")
    .map((entry) => String(entry.fields["mark"]));
}

async function presentedAt(card: number): Promise<number[]> {
  const view = await asMain("card", { card });
  if (!view.ok) return [];
  return check(CardViewSchema, view.value)
    .entries.filter((entry) => entry.fields["mark"] === "presented")
    .map((entry) => Number(entry.fields["occurrence"]));
}

async function untilMarked(card: number, mark: string, count = 1): Promise<void> {
  await untilAsync(
    async () =>
      (await marksOn(card)).filter((each) => each === mark).length >= count ? true : undefined,
    `${mark} on c-${String(card)}`,
  );
}

async function assistantTexts(): Promise<string[]> {
  const session = await h.waitFor((event) => event["type"] === "session", "the session file");
  return readFileSync(optionalString(session, "file") ?? "", "utf8")
    .split("\n")
    .filter(Boolean)
    .map(parseRecord)
    .map((entry) => entry["message"])
    .filter((message) => isRecord(message) && message["role"] === "assistant")
    .filter(isRecord)
    .map(messageText)
    .filter((text) => text !== "");
}

const decisionsIn = (text: string): string[] =>
  [OLDER, NEWER].filter((title) => text.includes(title));

const say = (text: string): Promise<void> => lab.submit(pane, text);

const listAfter = (from: number, match: (list: string) => boolean, what: string): Promise<string> =>
  until(() => lists.slice(from).find(match), what);

const listsAfter = (from: number, count: number): Promise<true> =>
  until(() => (lists.length >= from + count ? true : undefined), `${String(count)} more lists`);

test("a decision the captain has not seen since his last message is brought up one at a time, and yield cannot skip it", async () => {
  await startWithTwoHolds("writes");

  await listsAfter(0, 2);
  assert.ok(lists.every(noneDue), "nothing is due while he has not written");
  assert.ok(lists.every((list) => list.includes(OLDER) && list.includes(NEWER)));
  assert.deepEqual(refusals, []);

  await say("How is the build going?");
  const first = await listAfter(0, (list) => !noneDue(list), "the first due list");
  assert.deepEqual(dueIn(first), [{ card: older, title: OLDER }]);
  assert.match(first, new RegExp(`${NEWER} - waiting on the captain`));
  assert.doesNotMatch(first, /not a prompt to write to him/);
  const refused = await until<string>(() => refusals[0], "the refused yield");
  assert.match(
    refused,
    new RegExp(`yield refused: .*c-${String(older)} ${OLDER} is due: ${QUESTIONS[OLDER] ?? ""}`),
  );
  await untilMarked(older, "presented");
  assert.deepEqual(await marksOn(newer), []);
  const shown = lists.length;
  const settled = await listAfter(
    shown,
    (list) => noneDue(list) && list.includes(`${OLDER} - waiting on the captain`),
    "a list with nothing due after the decision was brought up",
  );
  assert.match(settled, new RegExp(`${OLDER}.*\\(shown since his last message\\)`));
  assert.doesNotMatch(settled, new RegExp(`${NEWER}.*shown since his last message`));

  await say("And what about the release?");
  const second = await listAfter(shown, (list) => dueTitles(list).includes(NEWER), "the other one");
  assert.deepEqual(dueTitles(second), [NEWER]);
  await until(() => (refusals.length >= 2 ? true : undefined), "the second refused yield");
  await untilMarked(newer, "presented");
  const rotated = lists.length;

  await say("Thanks, one more thing.");
  const third = await listAfter(rotated, (list) => dueTitles(list).includes(OLDER), "the rotation");
  assert.deepEqual(dueTitles(third), [OLDER]);
  await untilMarked(older, "presented", 2);

  const quiet = lists.length;
  await listAfter(quiet, noneDue, "a list with nothing due and no message from him");
  const before = refusals.length;
  await listsAfter(lists.length, 3);
  assert.equal(refusals.length, before, "a yield with nothing due goes through");

  const replies = await assistantTexts();
  const decisionReplies = replies.filter((text) => decisionsIn(text).length > 0);
  assert.deepEqual(decisionReplies.map(decisionsIn), [[OLDER], [NEWER], [OLDER]]);
  for (const reply of decisionReplies) assert.match(reply, /\+1 more waiting/);
  assert.deepEqual(
    (await cardd.thread(older)).entries.filter((entry) => entry.kind === "note"),
    [],
    "the marks stay out of the captain's thread",
  );
});

test("an afk message is recorded as away: nothing is due until he writes again", async () => {
  await startWithTwoHolds("writes");

  await say("afk for an hour");
  await untilMarked(newer + 1, "captain.away");
  const log = await cardd.thread(newer + 1);
  assert.equal(log.card.name, CAPTAIN_LOG_NAME);
  const waited = lists.length;
  await listsAfter(waited, 3);
  assert.ok(lists.slice(waited).every(noneDue), "nothing is due while he is away");
  assert.deepEqual(refusals, []);

  await say("Back, what did I miss?");
  const back = await listAfter(waited, (list) => !noneDue(list), "the due list after he is back");
  assert.deepEqual(dueTitles(back), [OLDER]);
  await until<string>(() => refusals[0], "the refused yield after he is back");
  assert.deepEqual(await marksOn(newer + 1), ["captain.away", "captain.seen"]);
});

for (const style of ["marks-silently", "yield-first", "codemode"] as const)
  test(`presented with yield without chat text is refused (${style})`, async () => {
    await startWithTwoHolds(style);

    await say("How is the build going?");
    const refusal = await until(
      () => refusals.find((each) => each.includes("wrote no chat text")),
      "the refused yield with no chat text",
    );
    assert.match(
      refusal,
      /yield refused: you called presented but wrote no chat text in this turn/,
    );
    const texts = await untilAsync(async () => {
      const found = await assistantTexts();
      return found.some((text) => decisionsIn(text).length > 0) ? found : undefined;
    }, "the decision written after the refusal");
    assert.ok(texts.every((text) => decisionsIn(text).length <= 1));
  });

test("a presentation queued before chat is refused when the hold was replaced meanwhile, and the new decision stays due", async () => {
  await startWithTwoHolds("marks-silently");
  beforeWriting = async () => {
    const { holds } = await cardd.board();
    const open = holds.find((each) => each.card === older);
    assert.ok(open !== undefined);
    assert.equal(await cardd.act(older, { kind: "answer", hold: open.hold, choice: "Yes" }), 200);
    const again = await asMain("hold", { card: older, question: QUESTIONS[OLDER] ?? "" });
    assert.ok(again.ok);
  };

  await say("How is the build going?");
  const second = await until(
    () => refusals.find((each) => each.includes(`c-${String(newer)} ${NEWER} is due:`)),
    "the other decision due right after the stale presentation",
  );
  assert.match(second, /yield refused/);
  assert.deepEqual(await presentedAt(older), []);
  await untilMarked(newer, "presented");

  await say("And the release?");
  const back = await listAfter(0, (list) => dueTitles(list).includes(OLDER), "the replacement");
  assert.deepEqual(dueTitles(back), [OLDER]);
  await untilAsync(async () => ((await presentedAt(older)).length > 0 ? true : undefined), "mark");
  assert.deepEqual(await presentedAt(older), [2]);
});

test("the captain's message sent while cardd is down is recorded once it is back", async () => {
  await startWithTwoHolds("writes");
  await listsAfter(0, 1);
  await cardd.stop();

  await say("How is the build going?");
  await until(() => steps.find((each) => each.includes("How is the build going?")), "the message");
  await cardd.restart();

  const refused = await until<string>(() => refusals[0], "the refused yield after cardd is back");
  assert.match(refused, new RegExp(`c-${String(older)} ${OLDER} is due:`));
  assert.deepEqual(await marksOn(newer + 1), ["captain.seen"]);
  await untilMarked(older, "presented");
});

test("an afk message sent while cardd is down still keeps the decisions from being brought up", async () => {
  await startWithTwoHolds("writes");
  await say("How is the build going?");
  await untilMarked(older, "presented");
  await cardd.stop();

  await say("afk for an hour");
  await until(() => steps.find((each) => each.includes("afk for an hour")), "the afk message");
  await cardd.restart();

  await untilAsync(
    async () => ((await marksOn(newer + 1)).includes("captain.away") ? true : undefined),
    "the away mark once cardd is back",
  );
  assert.deepEqual(await marksOn(newer + 1), ["captain.seen", "captain.away"]);
  const waited = lists.length;
  await listsAfter(waited, 3);
  assert.ok(lists.slice(waited).every(noneDue), "nothing is due while he is away");
  assert.equal(refusals.length, 1);
});
