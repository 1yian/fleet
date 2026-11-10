import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { BoardSchema, CardSchema, check } from "@fleet/protocol";
import { Cardd, type Session } from "../support/cardd.ts";
import {
  AUDIENCE,
  exchange,
  macSigned,
  OWNER,
  PUBLIC_HOST,
  signed,
  signingKey,
  Site,
  unsigned,
  upgrade,
} from "../support/public-host.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const SECRET = "The secret roadmap";
const ORIGIN = `https://${PUBLIC_HOST}`;
const JSON_BODY = { "content-type": "application/json" };
const TOKEN_HEADER = "cf-access-jwt-assertion";
const HOUR = 3600;

let site: Site;
let cardd: Cardd;
let main: Session;
let mainToken: string;

before(async () => {
  site = await Site.start();
});
after(async () => {
  await site.issuer.stop();
});
beforeEach(async () => {
  site.issuer.hits = 0;
  site.issuer.mode = "serving";
  site.issuer.published = [site.key];
  cardd = await Cardd.start(site.env, [...site.flags, "--board", BOARD]);
  mainToken = cardd.addLane("main");
  main = await cardd.connect(mainToken);
});
afterEach(async () => {
  await cardd.stop();
});

const base = (): URL => new URL(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));
const now = (): number => Math.floor(Date.now() / 1000);

function through(
  token: string | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  const tokenHeader = token === undefined ? {} : { [TOKEN_HEADER]: token };
  return { host: PUBLIC_HOST, origin: ORIGIN, ...tokenHeader, ...extra };
}

interface Seeded {
  card: number;
  action: unknown;
}

async function seeded(): Promise<Seeded> {
  const card = check(CardSchema, await main.call("card.new", { title: SECRET, kind: "captain" }));
  await main.call("hold", { card: card.id, question: "Ship it?", options: ["Yes", "No"] });
  const board = await cardd.board();
  const revision = board.cards.find((each) => each.id === card.id)?.revision ?? -1;
  const hold = board.holds[0]?.hold ?? -1;
  return {
    card: card.id,
    action: { card: card.id, revision, action: { kind: "answer", hold, choice: "Yes" } },
  };
}

const open = async (): Promise<number> => (await cardd.board()).holds.length;

async function assertRefusedEverywhere(
  label: string,
  headers: Record<string, string>,
  seed: Seeded,
): Promise<void> {
  const reads = ["/", "/api/board", `/api/card/${String(seed.card)}`, "/api/version"];
  for (const path of reads) {
    const answer = await exchange(base(), path, "GET", headers);
    assert.equal(answer.status, 403, `${label}: GET ${path}`);
    assert.ok(!answer.body.includes(SECRET), `${label}: GET ${path} leaked a card`);
    assert.ok(!/<html|<!doctype/i.test(answer.body), `${label}: GET ${path} served the page`);
  }
  const action = await exchange(
    base(),
    "/api/action",
    "POST",
    { ...JSON_BODY, ...headers },
    seed.action,
  );
  assert.equal(action.status, 403, `${label}: POST /api/action`);
  assert.equal(await open(), 1, `${label}: the action was applied`);
  assert.equal(await upgrade(base(), "/live", headers), "refused", `${label}: /live`);
}

test("a token from the owner opens the page, the data, /live, and an action through the public host", async () => {
  const seed = await seeded();
  const headers = through(site.token());

  const page = await exchange(base(), "/", "GET", headers);
  assert.equal(page.status, 200);
  assert.match(page.body, /<div id="root">/);
  const board = check(
    BoardSchema,
    JSON.parse((await exchange(base(), "/api/board", "GET", headers)).body),
  );
  assert.ok(board.cards.some((each) => each.title === SECRET));
  assert.equal(
    (await exchange(base(), `/api/card/${String(seed.card)}`, "GET", headers)).status,
    200,
  );
  assert.equal((await exchange(base(), "/api/version", "GET", headers)).status, 200);
  assert.equal(await upgrade(base(), "/live", headers), "opened");

  const mixed = through(site.token({ email: OWNER.toUpperCase() }), {
    host: PUBLIC_HOST.toUpperCase(),
  });
  assert.equal((await exchange(base(), "/api/board", "GET", mixed)).status, 200);

  const act = await exchange(
    base(),
    "/api/action",
    "POST",
    { ...JSON_BODY, ...headers },
    seed.action,
  );
  assert.equal(act.status, 200);
  assert.equal(await open(), 0);
  assert.equal(site.issuer.hits, 1);
});

test("a request for the public host without a valid token gets no board, page, data, action, or socket", async () => {
  const seed = await seeded();
  const claims = site.claims();
  const variants: Record<string, string | undefined> = {
    "no token": undefined,
    "a bad signature": signed(signingKey(site.key.kid), claims),
    "an unpublished key": signed(signingKey("rotated"), claims),
    "another application": site.token({ aud: ["cd".repeat(32)] }),
    "another team": site.token({ iss: "https://other.example.test" }),
    "an expired token": site.token({ exp: now() - HOUR }),
    "a token that is not valid yet": site.token({ nbf: now() + HOUR }),
    "no expiry": site.token({ exp: undefined }),
    "alg none": unsigned(site.key, claims),
    "HS256 keyed with the public key": macSigned(site.key, claims),
    "another email": site.token({ email: "intruder@example.test" }),
    "no email": site.token({ email: undefined }),
    garbage: "not.a.token",
  };
  for (const [label, token] of Object.entries(variants))
    await assertRefusedEverywhere(label, through(token), seed);

  const cookie = through(undefined, { cookie: `CF_Authorization=${site.token()}` });
  await assertRefusedEverywhere("the token only in the cookie", cookie, seed);
});

test("a valid token is not enough from a page of another origin, or without one on a write", async () => {
  const seed = await seeded();
  const token = site.token();
  const without = { host: PUBLIC_HOST, [TOKEN_HEADER]: token };
  assert.equal((await exchange(base(), "/api/board", "GET", without)).status, 200);
  const write = await exchange(
    base(),
    "/api/action",
    "POST",
    { ...JSON_BODY, ...without },
    seed.action,
  );
  assert.equal(write.status, 403);
  assert.equal(await upgrade(base(), "/live", without), "refused");

  for (const origin of [
    "https://evil.example",
    `http://${PUBLIC_HOST}`,
    `https://${PUBLIC_HOST}:8443`,
    "null",
  ]) {
    await assertRefusedEverywhere(`origin ${origin}`, through(token, { origin }), seed);
  }
});

test("the public host serves the board and nothing else, even to the owner", async () => {
  await seeded();
  const headers = through(site.token());
  const call = await exchange(
    base(),
    "/call",
    "POST",
    { ...JSON_BODY, ...headers, authorization: `Bearer ${mainToken}` },
    { op: "card.new", args: { title: "Made through the public host", kind: "captain" } },
  );
  assert.equal(call.status, 404);
  assert.ok(!(await cardd.board()).cards.some((each) => each.title.startsWith("Made through")));
  assert.equal((await exchange(base(), "/api/health", "GET", headers)).status, 404);
  assert.equal(await upgrade(base(), "/session", headers), "refused");
});

test("a request with a tailnet host name that came through Cloudflare or names the public host is refused, token or not", async () => {
  const seed = await seeded();
  const own = new URL(cardd.url.replace(/^ws/, "http")).host;
  const valid = site.token();
  const cases: Record<string, Record<string, string>> = {
    "the public origin": { origin: ORIGIN },
    "the public origin over http": { origin: `http://${PUBLIC_HOST}` },
    "the public origin and a valid token": { origin: ORIGIN, [TOKEN_HEADER]: valid },
    "a Cloudflare client address": { "cf-connecting-ip": "203.0.113.7" },
    "a Cloudflare ray": { "cf-ray": "8a1b2c3d4e5f-AMS" },
    "a Cdn-Loop": { "cdn-loop": "cloudflare; loops=1" },
    "a valid Access token": { [TOKEN_HEADER]: valid },
    "everything the tunnel adds": {
      origin: ORIGIN,
      "cf-connecting-ip": "203.0.113.7",
      "cf-ray": "8a1b2c3d4e5f-AMS",
      [TOKEN_HEADER]: valid,
    },
  };
  for (const [label, extra] of Object.entries(cases)) {
    const headers = { host: own, ...extra };
    await assertRefusedEverywhere(label, headers, seed);
    const call = await exchange(
      base(),
      "/call",
      "POST",
      { ...JSON_BODY, ...headers, authorization: `Bearer ${mainToken}` },
      { op: "card.new", args: { title: "Made through the tunnel", kind: "captain" } },
    );
    assert.equal(call.status, 403, `${label}: POST /call`);
    assert.equal(
      (await exchange(base(), "/api/health", "GET", headers)).status,
      403,
      `${label}: health`,
    );
    assert.equal(await upgrade(base(), "/session", headers), "refused", `${label}: /session`);
  }
  assert.ok(!(await cardd.board()).cards.some((each) => each.title.startsWith("Made through")));
});

test("tailnet access is unchanged when a public host is configured", async () => {
  const seed = await seeded();
  const own = new URL(cardd.url.replace(/^ws/, "http")).host;
  const plain = { host: own };

  assert.equal((await exchange(base(), "/", "GET", plain)).status, 200);
  assert.equal((await exchange(base(), "/api/board", "GET", plain)).status, 200);
  assert.equal((await exchange(base(), "/api/health", "GET", plain)).status, 200);
  assert.equal(
    (await exchange(base(), "/api/board", "GET", { host: `evil.example:${base().port}` })).status,
    403,
  );
  assert.equal(
    (await exchange(base(), "/api/board", "GET", { ...plain, origin: ORIGIN })).status,
    403,
  );
  assert.equal(await upgrade(base(), "/live", { ...plain, origin: `http://${own}` }), "opened");
  assert.equal(
    (await cardd.post(mainToken, "card.new", { title: "Tailnet", kind: "captain" })).status,
    200,
  );
  assert.equal(
    await cardd.act(seed.card, {
      kind: "answer",
      hold: (await cardd.board()).holds[0]?.hold ?? -1,
      choice: "Yes",
    }),
    200,
  );
  assert.equal(await open(), 0);
  assert.equal(site.issuer.hits, 0);
});

test("without the four public-host values, cardd refuses the public host and its https origin as it always did", async () => {
  await cardd.stop();
  cardd = await Cardd.start({}, ["--board", BOARD]);
  const own = new URL(cardd.url.replace(/^ws/, "http")).host;
  const token = site.token();

  const named = await exchange(base(), "/api/board", "GET", through(token));
  assert.equal(named.status, 403);
  assert.match(named.body, /only to these hosts: .*127\.0\.0\.1:\d+/);
  assert.equal((await exchange(base(), "/", "GET", through(token))).status, 403);
  const rebound = await exchange(
    base(),
    "/api/action",
    "POST",
    { ...JSON_BODY, ...through(token) },
    {},
  );
  assert.equal(rebound.status, 403);
  assert.equal(await upgrade(base(), "/live", through(token)), "refused");
  assert.equal(
    (await exchange(base(), "/api/board", "GET", { host: own, origin: ORIGIN })).status,
    403,
  );
  assert.equal(await upgrade(base(), "/live", { host: own, origin: ORIGIN }), "refused");

  const forwarded = { host: own, "cf-ray": "8a1b2c3d4e5f-AMS", [TOKEN_HEADER]: token };
  assert.equal((await exchange(base(), "/api/board", "GET", forwarded)).status, 200);
  assert.equal(await upgrade(base(), "/live", forwarded), "opened");
  assert.equal(site.issuer.hits, 0);
});

test("the four public-host values are set together, and each is checked at start", () => {
  const [host, team, aud, email] = site.flags.filter((_, index) => index % 2 === 1);
  const flags = {
    "--public-host": host ?? "",
    "--access-team": team ?? "",
    "--access-aud": aud ?? "",
    "--access-email": email ?? "",
  };
  const without = (name: string): string[] =>
    Object.entries(flags).flatMap(([flag, value]) => (flag === name ? [] : [flag, value]));
  const withValue = (name: string, value: string): string[] =>
    Object.entries(flags).flatMap(([flag, was]) => [flag, flag === name ? value : was]);

  for (const name of Object.keys(flags)) {
    const refused = cardd.failToServe(...without(name));
    assert.notEqual(refused.status, 0, `without ${name}`);
    assert.match(refused.stderr, /are set together or not at all/, `without ${name}`);
  }
  const bad: [string, string][] = [
    ["--public-host", `https://${PUBLIC_HOST}`],
    ["--public-host", `${PUBLIC_HOST}:8443`],
    ["--public-host", `${PUBLIC_HOST}/board`],
    ["--access-team", "https://team.cloudflareaccess.com"],
    ["--access-team", "team.cloudflareaccess.com/cdn-cgi"],
    ["--access-aud", "ab".repeat(31)],
    ["--access-aud", "not an aud tag"],
    ["--access-email", "nobody"],
  ];
  for (const [name, value] of bad) {
    const refused = cardd.failToServe(...withValue(name, value));
    assert.notEqual(refused.status, 0, `${name} ${value}`);
    assert.ok(
      refused.stderr.includes(`${name} ${value} must be`),
      `${name} ${value}: ${refused.stderr}`,
    );
  }
  const shared = cardd.failToServe(
    "--listen",
    "127.0.0.1:0",
    "--hostname",
    `${PUBLIC_HOST}:80`,
    ...site.flags,
  );
  assert.notEqual(shared.status, 0);
  assert.match(shared.stderr, /is the public host/);
  assert.equal(AUDIENCE.length, 64);
});

test("the signing keys are fetched once and kept, and an unknown key id cannot make cardd fetch them again within the cooldown", async () => {
  const seed = await seeded();
  const valid = through(site.token());
  for (let each = 0; each < 5; each += 1)
    assert.equal((await exchange(base(), "/api/board", "GET", valid)).status, 200);
  assert.equal(site.issuer.hits, 1);

  const strange = through(signed(signingKey("rotated"), site.claims()));
  for (let each = 0; each < 20; each += 1)
    assert.equal((await exchange(base(), "/api/board", "GET", strange)).status, 403);
  await assertRefusedEverywhere("the unknown key", strange, seed);
  assert.equal(site.issuer.hits, 1);
  assert.equal((await exchange(base(), "/api/board", "GET", valid)).status, 200);
});

async function eventually(what: string, reached: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await reached())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a key that Cloudflare rotated in is picked up once the cooldown has passed", async () => {
  await cardd.stop();
  cardd = await Cardd.start({ ...site.env, CARDD_TIMING_SCALE: "0.01" }, [
    ...site.flags,
    "--board",
    BOARD,
  ]);
  const first = through(site.token());
  assert.equal((await exchange(base(), "/api/board", "GET", first)).status, 200);
  assert.equal(site.issuer.hits, 1);

  const next = signingKey("next");
  site.issuer.published = [site.key, next];
  const rotated = through(signed(next, site.claims()));
  await eventually("the rotated key to be accepted", async () => {
    return (await exchange(base(), "/api/board", "GET", rotated)).status === 200;
  });
  assert.equal(site.issuer.hits, 2);
  assert.equal((await exchange(base(), "/api/board", "GET", first)).status, 200);
});

test("when the certs cannot be fetched every request is refused, and the board opens again when they can", async () => {
  await cardd.stop();
  cardd = await Cardd.start({ ...site.env, CARDD_TIMING_SCALE: "0.01" }, [
    ...site.flags,
    "--board",
    BOARD,
  ]);
  main = await cardd.connect(cardd.addLane("main"));
  const seed = await seeded();
  const valid = through(site.token());

  site.issuer.mode = "failing";
  await assertRefusedEverywhere("certs answering 500", valid, seed);
  assert.ok(site.issuer.hits >= 1);

  site.issuer.mode = "serving";
  await eventually("the board to open again", async () => {
    return (await exchange(base(), "/api/board", "GET", valid)).status === 200;
  });
});

test("a failed fetch of the signing keys is not repeated within the cooldown, however many requests arrive", async () => {
  site.issuer.mode = "failing";
  const valid = through(site.token());
  for (let each = 0; each < 10; each += 1)
    assert.equal((await exchange(base(), "/api/board", "GET", valid)).status, 403);
  assert.equal(site.issuer.hits, 1);
});

test("when the certs endpoint is not there at all, every request is refused", async () => {
  const gone = await Site.start();
  await gone.issuer.stop();
  await cardd.stop();
  cardd = await Cardd.start(gone.env, [...gone.flags, "--board", BOARD]);
  main = await cardd.connect(cardd.addLane("main"));
  const seed = await seeded();
  await assertRefusedEverywhere("certs unreachable", through(gone.token()), seed);
});
