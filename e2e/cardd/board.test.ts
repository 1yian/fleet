// The board's door into cardd (spec section 21), against a real cardd: only its
// own origin may use it, and an answer names the question it answers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { BoardSchema, CardSchema, check, type Board } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";

const MAIN = fileURLToPath(new URL("../../packages/cardd/src/main.ts", import.meta.url));

let cardd: Cardd;
let main: Session;
beforeEach(async () => {
  cardd = await Cardd.start();
  main = await cardd.connect(cardd.addLane("main"));
});
afterEach(async () => {
  await cardd.stop();
});

const base = (): URL => new URL(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));

function send(
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base()), { method, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: text });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const view = async (): Promise<Board> =>
  check(BoardSchema, JSON.parse((await send("/api/board", "GET", {})).body));

async function twoQuestions(): Promise<{ card: number; revision: number; asks: number[] }> {
  const card = check(CardSchema, await main.call("card.new", { title: "Two", kind: "captain" }));
  await main.call("ask", { card: card.id, question: "Which version?", options: ["v1", "v2"] });
  await main.call("ask", { card: card.id, question: "Ship it?", options: ["yes", "no"] });
  const board = await view();
  const revision = board.cards.find((each) => each.id === card.id)?.revision ?? -1;
  return { card: card.id, revision, asks: board.questions.map((each) => each.ask) };
}

const json = { "content-type": "application/json" };

test("a page from another origin cannot act on the board, read it, or watch it", async () => {
  const { card, revision, asks } = await twoQuestions();
  const action = { card, revision, action: { kind: "answer", ask: asks[0], choice: "v1" } };
  const foreign = { origin: "http://evil.example" };

  const refused = await send("/api/action", "POST", { ...json, ...foreign }, action);
  assert.equal(refused.status, 403);
  assert.equal((await send("/api/board", "GET", foreign)).status, 403);
  const simple = await send("/api/action", "POST", { "content-type": "text/plain" }, action);
  assert.equal(simple.status, 400);
  assert.equal((await view()).questions.length, 2);

  const watch = (origin: string | undefined): Promise<"opened" | "refused"> =>
    new Promise((resolve) => {
      const headers = {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(origin === undefined ? {} : { origin }),
      };
      const req = request(new URL("/live", base()), { headers });
      req.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve("opened");
      });
      req.on("error", () => {
        resolve("refused");
      });
      req.end();
    });
  assert.equal(await watch("http://evil.example"), "refused");
  assert.equal(await watch(base().origin), "opened");

  const own = await send("/api/action", "POST", { ...json, origin: base().origin }, action);
  assert.equal(own.status, 200);
  assert.equal((await view()).questions.length, 1);
});

test("an answer goes to the question it names, and a closed question is refused", async () => {
  const { card, asks } = await twoQuestions();
  const [first = -1, second = -1] = asks;
  assert.equal(asks.length, 2);
  const answer = async (ask: number, choice: string) => {
    const revision = (await view()).cards.find((each) => each.id === card)?.revision ?? -1;
    return send("/api/action", "POST", json, {
      card,
      revision,
      action: { kind: "answer", ask, choice },
    });
  };

  assert.equal((await answer(second, "yes")).status, 200);
  assert.deepEqual(
    (await view()).questions.map((each) => each.ask),
    [first],
  );
  const again = await answer(second, "no");
  assert.equal(again.status, 409);
  assert.equal((await answer(first, "v2")).status, 200);
  assert.equal((await view()).questions.length, 0);
});

const serveWith = (listen: string): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolve) => {
    const child = execFile(
      "node",
      [MAIN, "serve", "--db", cardd.db + ".other", "--listen", listen],
      { encoding: "utf8", timeout: 10_000 },
      (error, _out, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : -1,
          stderr,
        });
      },
    );
    child.stdin?.end();
  });

test("cardd refuses to listen on every interface, however the address is written", async () => {
  for (const listen of ["0.0.0.0:0", "0:0", "[::]:0", "[0:0:0:0:0:0:0:0]:0"]) {
    const result = await serveWith(listen);
    assert.notEqual(result.code, 0, listen);
    assert.match(result.stderr, /never to every interface/, listen);
  }
  for (const listen of [":0", "127.0.0.1", "127.0.0.1:", "::"]) {
    const result = await serveWith(listen);
    assert.notEqual(result.code, 0, listen);
    assert.match(result.stderr, /must be <host>:<port>, with both parts set/, listen);
  }
});
