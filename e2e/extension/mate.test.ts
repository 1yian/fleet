import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { CardSchema, check, type Card } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, startFleet, type Fleet } from "../support/fleet.ts";
import { FakeGitHub } from "../support/github.ts";
import { Harness, type Turn } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

let fleet: Fleet;
let gh: FakeGitHub;
let h: Harness;
beforeEach(async () => {
  gh = new FakeGitHub();
  fleet = await startFleet(gh.env);
  h = await Harness.start();
});
afterEach(async () => {
  await h.stop();
  await fleet.cardd.stop();
});

const toolResults = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);

async function startMate(name: string, token: string) {
  const mate = h.startPi(
    name,
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "mate" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  return mate;
}

const cardIn = async (mate: Session, title: string, project: string): Promise<Card> =>
  check(CardSchema, await mate.call("card.new", { title, kind: "ship", project }));

async function doneWith(mate: Session, card: Card, pr: string): Promise<void> {
  const worker = await fleet.cardd.connect(await begin(mate, card));
  await worker.call("report", { status: "done", text: "PR green and ready", pr });
}

test("hold sets a hold, and clear=true clears it only with words the captain said", async () => {
  const cleo = fleet.cardd.addLane("cleo", "main");
  h.onModel(() => ({
    tool: "card_new",
    args: { title: "Pick the API version", name: "api-version", kind: "captain" },
  }));
  h.onModel(() => ({ tool: "hold", args: { card: 2, question: "v1 or v2?" } }));
  h.onModel(() => ({ tool: "hold", args: { card: 2, clear: true, question: "v3?" } }));
  h.onModel(() => ({ tool: "hold", args: { card: 2, clear: true, words: "use v3" } }));
  h.onModel(() => ({ tool: "hold", args: { card: 2, clear: true, words: "use the v2 endpoint" } }));
  h.onModel(() => ({ text: "recorded" }));
  const mate = await startMate("cleo", cleo);
  mate.prompt(
    "Make a card for the API version and hold it for me. My answer: use the v2 endpoint.",
  );

  const results = toolResults(await h.waitForCall(5));
  assert.deepEqual(results.slice(1), [
    "Held. c-2 is now with-mate.",
    "clear=true takes words or note, not question",
    "these words are not in the captain's messages or board entries; quote the captain exactly",
    "Cleared. c-2 is now with-mate.",
  ]);
  const thread = await fleet.cardd.thread(2);
  assert.deepEqual(
    thread.entries.map(({ kind, body }) => `${kind}: ${body}`),
    ["hold: v1 or v2?", "answer: use the v2 endpoint"],
  );
});

test("yolo on puts a done PR in Merging with no question; yolo off holds it for the merge question, and close refuses both until the PR merges", async () => {
  fleet.cardd.addProject("api", { maverick: "/clones/api" });
  fleet.cardd.yolo("api");
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  const yolo = await cardIn(cleo, "Speed up the API", "api");
  const asks = await cardIn(cleo, "Users see one scrollbar", "web");
  const [apiPr, webPr] = [
    "https://github.com/acme/api/pull/3",
    "https://github.com/acme/web/pull/7",
  ];
  gh.setPr(apiPr, "OPEN", { ci: "pass" });
  gh.setPr(webPr, "OPEN", { ci: "pass" });
  await doneWith(cleo, yolo, apiPr);
  await doneWith(cleo, asks, webPr);

  h.onModel(() => ({ tool: "board", args: { fields: "project,pr" } }));
  h.onModel(() => ({ tool: "close", args: { card: asks.id, summary: "Shipped." } }));
  h.onModel(() => ({ tool: "close", args: { card: yolo.id, summary: "Shipped." } }));
  h.onModel(() => ({ text: "the API PR may merge; the scrollbar waits on the captain" }));
  const mate = await startMate("main", fleet.mainToken);
  mate.prompt("Land what is ready.");

  const [board, held, unmerged] = toolResults(await h.waitForCall(3));
  assert.match(board ?? "", /^ {2}\d+,with-mate,main,Users see one scrollbar,web,/m);
  assert.match(board ?? "", /^ {2}\d+,merging,merge,Speed up the API,api,/m);
  assert.equal(
    held,
    `c-${String(asks.id)} has an open hold; clear it first with hold(card, clear=true), with the captain's words when it waits on him`,
  );
  assert.equal(
    unmerged,
    `c-${String(yolo.id)} did not land: its PR ${apiPr} has not merged. Once the merge is authorized (yolo on with green checks, or the captain's word for this PR), comment the worker to merge it, then close it. To end it anyway, call close(card, summary=<why it is dropped>, landed=false). That marks it Dropped and archives its work.`,
  );
  assert.deepEqual([gh.state(apiPr), gh.state(webPr)], ["OPEN", "OPEN"]);
});

test("main hands work to a second mate with comment(lane), and card_new refuses the lane", async () => {
  const cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
  h.onModel(() => ({
    tool: "card_new",
    args: { title: "Ads stay under budget", name: "ads-budget", kind: "scout", lane: "cleo" },
  }));
  h.onModel(() => ({
    tool: "comment",
    args: { lane: "cleo", text: "The captain asks: keep ads under budget" },
  }));
  h.onModel(() => ({ text: "handed over" }));
  const mate = await startMate("main", fleet.mainToken);
  mate.prompt("Hand the ad budget work to cleo.");

  const results = toolResults(await h.waitForCall(2));
  assert.match(
    results[0] ?? "",
    /^card_new cannot create a card in lane cleo\. To hand work to cleo/,
  );
  assert.equal(results[1], "Commented. c-1 [waiting] cleo");
  const heard = await cleo.waitForEntry((entry) => entry.author === "mate:main", "main's comment");
  assert.equal(heard.body, "The captain asks: keep ads under budget");
});
