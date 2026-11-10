import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CardSchema, check, type Card } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import { boundBoardFile } from "../support/board.ts";
import { Edge, PUBLIC_HOST, signed, signingKey, Site } from "../support/public-host.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const FIRST = "Pick the API version";
const SECOND = "Ship it on Friday";

boundBoardFile();

let site: Site;
let cardd: Cardd;
let main: Session;
let edge: Edge;
let browser: Browser;
let page: Page;

before(async () => {
  site = await Site.start();
});
after(async () => {
  await site.issuer.stop();
});
beforeEach(async () => {
  site.issuer.hits = 0;
  cardd = await Cardd.start(site.env, [...site.flags, "--board", BOARD]);
  main = await cardd.connect(cardd.addLane("main"));
  edge = await Edge.start(new URL(cardd.url.replace(/^ws/, "http")));
  edge.token = site.token();
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${PUBLIC_HOST} 127.0.0.1:${String(edge.port)}`],
  });
  page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
});
afterEach(async () => {
  await browser.close();
  await edge.stop();
  await cardd.stop();
});

const link = `https://${PUBLIC_HOST}/`;

async function question(title: string, options: string[]): Promise<Card> {
  const card = check(CardSchema, await main.call("card.new", { title, kind: "captain" }));
  await main.call("hold", { card: card.id, question: `${title}?`, options });
  return card;
}

test("the owner opens the board through the public link, sees it change live, and answers a hold", async () => {
  await question(FIRST, ["v1", "v2"]);
  const sockets: string[] = [];
  let navigations = 0;
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("framenavigated", () => (navigations += 1));

  const response = await page.goto(link);
  assert.equal(response?.status(), 200);
  const needs = page.getByRole("region", { name: "Needs you" });
  await needs.getByText(`${FIRST}?`).waitFor();

  await question(SECOND, ["Yes", "No"]);
  await needs.getByText(`${SECOND}?`).waitFor();
  assert.deepEqual(sockets, [`wss://${PUBLIC_HOST}/live`]);
  assert.equal(navigations, 1);

  await needs
    .getByRole("article")
    .filter({ hasText: `${SECOND}?` })
    .getByRole("button", { name: "Yes" })
    .click();
  const answer = await main.waitForEntry((entry) => entry.kind === "answer", "the answer");
  assert.equal(answer.body, "Yes");
  await needs.getByText(`${SECOND}?`).waitFor({ state: "detached" });
  assert.equal(site.issuer.hits, 1);
});

test("through the public link, anything but the owner's valid token gets no board", async () => {
  await question(FIRST, ["v1", "v2"]);
  const claims = site.claims();
  const refused: Record<string, string | undefined> = {
    "no token": undefined,
    "a token signed by another key": signed(signingKey(site.key.kid), claims),
    "a token for another application": site.token({ aud: ["cd".repeat(32)] }),
    "an expired token": site.token({ exp: Math.floor(Date.now() / 1000) - 3600 }),
    "a token for another email": site.token({ email: "intruder@example.test" }),
  };
  for (const [label, token] of Object.entries(refused)) {
    edge.token = token;
    const response = await page.goto(link);
    assert.equal(response?.status(), 403, label);
    assert.equal(await page.locator("#root").count(), 0, label);
    assert.ok(!(await page.content()).includes(FIRST), label);
  }
});

test("a tunnel that still rewrites the Host header to the tailnet name is refused, whatever the token", async () => {
  await question(FIRST, ["v1", "v2"]);
  edge.rewriteHost = new URL(cardd.url.replace(/^ws/, "http")).host;
  const response = await page.goto(link);
  assert.equal(response?.status(), 403);
  assert.ok(!(await page.content()).includes(FIRST));
});
