// The board's door into cardd (spec section 21), against a real cardd: only its
// own origin may use it, and an answer names the question it answers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request } from "node:http";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { BoardSchema, CardSchema, check, OPS, ThreadSchema, type Board } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
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

/** A card with one hold that bundles two questions. */
async function twoQuestions(): Promise<{ card: number; revision: number; hold: number }> {
  const card = check(CardSchema, await main.call("card.new", { title: "Two", kind: "captain" }));
  const question = "1. Which version?\n2. Ship it?";
  await main.call("hold", { card: card.id, question, options: ["v1 and ship", "v2 and wait"] });
  const board = await view();
  const revision = board.cards.find((each) => each.id === card.id)?.revision ?? -1;
  return { card: card.id, revision, hold: board.holds[0]?.hold ?? -1 };
}

const json = { "content-type": "application/json" };

test("a page from another origin cannot act on the board, read it, or watch it", async () => {
  const { card, revision, hold } = await twoQuestions();
  const action = { card, revision, action: { kind: "answer", hold, choice: "v1 and ship" } };
  const foreign = { origin: "http://evil.example" };

  const refused = await send("/api/action", "POST", { ...json, ...foreign }, action);
  assert.equal(refused.status, 403);
  assert.equal((await send("/api/board", "GET", foreign)).status, 403);
  const simple = await send("/api/action", "POST", { "content-type": "text/plain" }, action);
  assert.equal(simple.status, 400);
  assert.equal((await view()).holds.length, 1);

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
  assert.equal((await view()).holds.length, 0);
});

test("a request that names a host other than cardd's own address is refused, even from its own page", async () => {
  const { card, revision, hold } = await twoQuestions();
  const action = { card, revision, action: { kind: "answer", hold, choice: "v1 and ship" } };
  const port = base().port;
  const host = `evil.example:${port}`;
  const rebound = { host, origin: `http://${host}` };

  assert.equal((await send("/api/board", "GET", { host })).status, 403);
  assert.equal((await send(`/api/card/${String(card)}`, "GET", { host })).status, 403);
  assert.equal((await send("/", "GET", { host })).status, 403);
  assert.equal((await send("/api/action", "POST", { ...json, ...rebound }, action)).status, 403);
  assert.equal((await view()).holds.length, 1);

  const upgrade = (headers: Record<string, string>): Promise<"opened" | "refused"> =>
    new Promise((resolve) => {
      const req = request(new URL("/live", base()), {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        },
      });
      req.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve("opened");
      });
      req.on("error", () => {
        resolve("refused");
      });
      req.end();
    });
  assert.equal(await upgrade(rebound), "refused");
  assert.equal(await upgrade({ host: `127.0.0.1:${port}` }), "opened");

  const own = await send("/api/action", "POST", { ...json, host: `127.0.0.1:${port}` }, action);
  assert.equal(own.status, 200);
});

test("a name given with --hostname reaches the board, and no other name does", async () => {
  await cardd.stop();
  cardd = await Cardd.start({}, ["--hostname", "Board.Example"]);
  const port = base().port;
  const reach = async (host: string): Promise<number> =>
    (await send("/api/board", "GET", { host })).status;

  assert.equal(await reach(`board.example:${port}`), 200);
  assert.equal(await reach(`127.0.0.1:${port}`), 200);
  assert.equal(await reach(`other.example:${port}`), 403);
  assert.equal(await reach("board.example"), 403);
});

test("a name given with the default port is the same authority with or without the port", async () => {
  await cardd.stop();
  cardd = await Cardd.start({}, ["--hostname", "board.example:80"]);
  const port = base().port;
  const reach = async (host: string, origin?: string): Promise<number> =>
    (await send("/api/board", "GET", origin === undefined ? { host } : { host, origin })).status;

  assert.equal(await reach("board.example"), 200);
  assert.equal(await reach("Board.Example:80"), 200);
  assert.equal(await reach("board.example", "http://board.example"), 200);
  assert.equal(await reach("board.example", "http://board.example:80"), 200);
  assert.equal(await reach(`board.example:${port}`), 403);
  assert.equal(await reach("other.example:80"), 403);
  assert.equal(await reach("board.example", "http://other.example"), 403);
});

test("an answer resolves the whole hold, and an answer to a hold that is released is refused", async () => {
  const { card, hold } = await twoQuestions();
  const answer = async (choice: string) => {
    const revision = (await view()).cards.find((each) => each.id === card)?.revision ?? -1;
    return send("/api/action", "POST", json, {
      card,
      revision,
      action: { kind: "answer", hold, choice },
    });
  };

  assert.equal((await view()).holds.length, 1);
  assert.equal((await answer("v2 and wait")).status, 200);
  assert.equal((await view()).holds.length, 0);
  assert.equal((await answer("v1 and ship")).status, 409);
});

test("a hold that changed since the captain looked refuses his answer to the old one", async () => {
  const { card, hold } = await twoQuestions();
  await main.call("hold", { card, question: "1. Which version?\n2. Ship it?\n3. When?" });
  const revision = (await view()).cards.find((each) => each.id === card)?.revision ?? -1;
  const post = (revision: number, held: number) =>
    send("/api/action", "POST", json, {
      card,
      revision,
      action: { kind: "answer", hold: held, choice: "v1 and ship" },
    });

  assert.equal((await post(revision, hold)).status, 409);
  const current = (await view()).holds[0]?.hold ?? -1;
  assert.notEqual(current, hold);
  assert.equal((await post(revision, current)).status, 200);
});

test("a comment is accepted whatever the card's revision, and an answer or hold is not", async () => {
  const { card, revision, hold } = await twoQuestions();
  const stale = revision - 1;
  const post = (action: unknown) =>
    send("/api/action", "POST", json, { card, revision: stale, action });

  assert.equal((await post({ kind: "comment", text: "a thought" })).status, 200);
  assert.equal((await post({ kind: "answer", hold, choice: "v1 and ship" })).status, 409);
  const later = { kind: "hold", until: Date.now() + 3_600_000, reason: "later" };
  assert.equal((await post(later)).status, 409);
});

test("the board folder may be given as a relative path", async () => {
  await cardd.stop();
  cardd = await Cardd.start({}, ["--board", relative(process.cwd(), BOARD)]);
  const page = await send("/", "GET", {});
  assert.equal(page.status, 200);
  assert.match(page.body, /<div id="root">/);
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

test("a card's thread on the board is the whole conversation with its mate, without job results", async () => {
  cardd.addProject("web", { local: "/clones/web" });
  const args = { title: "Users see one scrollbar", kind: "ship", project: "web" };
  const card = check(CardSchema, await main.call("card.new", args));
  const begin = { card: card.id, host: "local", task: "Spec: fix the scrollbar" };
  const { token } = check(OPS["attempt.begin"].result, await main.call("attempt.begin", begin));
  const worker = await cardd.connect(token);
  const started = await worker.call("job.start", { label: "tests", command: "npm test" });
  const { job } = check(OPS["job.start"].result, started);
  await cardd.post(token, "job.finish", { job, exitCode: 127, outputTail: "gtimeout: not found" });
  await worker.call("report", { status: "working", text: "the tests run again\nstep 2 of 3" });
  await main.call("comment", { card: card.id, text: "also check the footer" });

  const shown: unknown = JSON.parse((await send(`/api/card/${String(card.id)}`, "GET", {})).body);
  const kinds = check(ThreadSchema, shown).entries.map((entry) => entry.kind);
  // The task message, the worker's report, and the mate's steer. Job results stay out.
  assert.deepEqual(kinds, ["comment", "report", "comment"]);
  // The card's summary on the board is the latest thing the captain reads, in one line.
  const summary = (await view()).cards.find((each) => each.id === card.id)?.summary;
  assert.equal(summary, "the tests run again");
  await worker.close();
});
