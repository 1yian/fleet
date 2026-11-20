import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Card, Entry } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { is, reportFailure } from "../support/incidents.ts";

const MODEL = "openai-codex/gpt-fixture";
const RATE_LIMITED = "HTTP 429 rate limit exceeded. Retry-After: 10800";

let fleet: Fleet;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await fleet.cardd.stop();
});

const onceEach = (session: Session): Entry[] => [
  ...new Map(session.entries.map((push) => [push.entry.id, push.entry])).values(),
];
const heardBy = (session: Session, condition: string, card?: Card): Entry[] =>
  onceEach(session).filter(
    (entry) => is(condition)(entry) && (card === undefined || entry.card === card.id),
  );

const reachedTier = (session: Session, card: Card, condition: string, tier: number) =>
  session.waitForEntry(
    (entry) =>
      entry.card === card.id && is(condition)(entry) && Number(entry.fields["tier"]) >= tier,
    `${condition} tier ${String(tier)} on c-${String(card.id)}`,
  );

const failingWorker = (
  card: Card,
  error: string,
  options: { model?: string; mate?: Session } = {},
): Promise<Session> => reportFailure(fleet, options.mate ?? cleo, card, error, options.model);

const INCIDENT_IDS = /Incident (\d+), process generation (\d+)/;

async function incidentHeard(
  mate: Session,
  not?: number,
): Promise<{ incident: number; generation: number }> {
  const heard = await mate.waitForEntry(
    (entry) =>
      is("runtime-failure")(entry) &&
      INCIDENT_IDS.exec(entry.body) !== null &&
      INCIDENT_IDS.exec(entry.body)?.[1] !== String(not),
    "the runtime failure",
  );
  const found = INCIDENT_IDS.exec(heard.body);
  return { incident: Number(found?.[1]), generation: Number(found?.[2]) };
}

const restart = (
  card: Card,
  incident: { incident: number; generation: number },
  rest: Record<string, unknown>,
  by: Session = cleo,
): Promise<unknown> => by.call("card.restart", { card: card.id, ...incident, ...rest });

const ELIGIBLE_AT = /eligible at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/;
const eligibleAt = (mate: Session, card: Card): string | undefined =>
  ELIGIBLE_AT.exec(heardBy(mate, "runtime-failure", card)[0]?.body ?? "")?.[1];

async function afterChecks(): Promise<void> {
  const witness = await newCard(cleo, "a clock for the test");
  await begin(cleo, witness);
  await reachedTier(cleo, witness, "worker-never-connected", 3);
}

test("a refused avoid on an explicit model reaches main once after the mate's first reminder, naming the card, lane, incident, and reason, and the mate's reminders go on", async () => {
  const card = await newCard(cleo, "Users see Spanish copy");
  const worker = await failingWorker(card, RATE_LIMITED, { model: MODEL });
  const incident = await incidentHeard(cleo);
  await assert.rejects(
    restart(card, incident, { mode: "replace", avoid: ["openai-codex"], key: "avoid" }),
    /cannot avoid openai-codex/,
  );

  const told = await fleet.main.waitForEntry(
    is("runtime-failure-unrecoverable"),
    "main to hear that no recovery is left",
  );
  const firstReminder = await reachedTier(cleo, card, "runtime-failure-open", 1);
  assert.ok(told.id > firstReminder.id, "main hears after the mate's first reminder");
  assert.equal(told.card, card.id);
  assert.equal(told.kind, "finding");
  assert.ok(!told.body.includes("\n"), told.body);
  for (const part of [
    `c-${String(card.id)} in lane cleo`,
    `incident ${String(incident.incident)}`,
    "HTTP 429",
    `was dispatched on ${MODEL}`,
    "a restart keeps that model",
  ])
    assert.ok(told.body.includes(part), `${part} in: ${told.body}`);
  const eligible = eligibleAt(cleo, card);
  assert.ok(eligible !== undefined, "the mate heard when the retry becomes eligible");
  assert.ok(
    told.body.includes(`A retry is still pending, eligible at ${eligible}.`),
    `the pending retry and its time in: ${told.body}`,
  );

  const last = await reachedTier(cleo, card, "runtime-failure-open", 4);
  assert.ok(last.id > told.id, "the mate's own reminders go on after main was told");
  assert.equal(heardBy(fleet.main, "runtime-failure-unrecoverable", card).length, 1);
  assert.equal(heardBy(fleet.main, "runtime-failure-open", card).length, 0);

  await worker.call("incident.clear", {});
  await afterChecks();
  assert.equal(heardBy(fleet.main, "runtime-failure-unrecoverable").length, 1);
});

test("another mate's refused avoid on a lane that is not its own records nothing and does not reach main", async () => {
  const dan = await fleet.cardd.connect(fleet.cardd.addLane("dan", "main"));
  const card = await newCard(cleo, "Users see Spanish copy");
  await failingWorker(card, RATE_LIMITED, { model: MODEL });
  const incident = await incidentHeard(cleo);
  await assert.rejects(
    restart(card, incident, { mode: "replace", avoid: ["openai-codex"], key: "foreign" }, dan),
    /only the direct parent can restart/,
  );

  await reachedTier(cleo, card, "runtime-failure-open", 4);
  assert.deepEqual(heardBy(fleet.main, "runtime-failure-unrecoverable"), []);
});

test("a stale restart request is refused as its own error and records nothing, so the new incident stays with its mate", async () => {
  const card = await newCard(cleo, "Users see Spanish copy");
  const worker = await failingWorker(card, RATE_LIMITED, { model: MODEL });
  const cleared = await incidentHeard(cleo);
  await worker.call("incident.clear", {});
  await worker.call("incident.report", { error: RATE_LIMITED });
  const current = await incidentHeard(cleo, cleared.incident);
  assert.notEqual(current.incident, cleared.incident);

  const avoid = { mode: "replace", avoid: ["openai-codex"] };
  await assert.rejects(
    restart(card, cleared, { ...avoid, key: "cached" }),
    /is cleared: there is nothing to recover/,
  );
  await assert.rejects(
    restart(card, { ...current, generation: current.generation + 1 }, { ...avoid, key: "stale" }),
    /read the card again/,
  );

  await cleo.waitForEntry(
    (entry) =>
      entry.fields["reminder"] === `runtime-failure-open:${String(current.incident)}` &&
      Number(entry.fields["tier"]) >= 4,
    "the mate's last reminder about the new incident",
  );
  assert.deepEqual(heardBy(fleet.main, "runtime-failure-unrecoverable"), []);
});

test("a pause and a resume of the same unrecoverable incident do not tell main a second time", async () => {
  const card = await newCard(cleo, "Users see one scrollbar");
  const worker = await failingWorker(card, "HTTP 401 invalid api key");
  await fleet.main.waitForEntry(
    is("runtime-failure-unrecoverable"),
    "main to hear about bad credentials",
  );

  await worker.call("report", {
    status: "paused",
    text: "waiting for a new key",
    until: Date.now() + 3_600_000,
  });
  await afterChecks();
  const reminded = new Set(heardBy(cleo, "runtime-failure-open", card).map((entry) => entry.id));
  await worker.call("report", { status: "working", text: "the key was replaced" });

  await cleo.waitForEntry(
    (entry) =>
      entry.card === card.id && is("runtime-failure-open")(entry) && !reminded.has(entry.id),
    "the mate's reminder after the resume",
  );
  await afterChecks();
  assert.equal(heardBy(fleet.main, "runtime-failure-unrecoverable", card).length, 1);
});

test("a failure whose retry becomes eligible at a known time does not reach main, even when the mate asks for it too early", async () => {
  const card = await newCard(cleo, "Users see Spanish copy");
  const before = Date.now();
  await failingWorker(card, `${RATE_LIMITED}\nRequest filter: *.json`, { model: MODEL });
  const incident = await incidentHeard(cleo);
  const [heard] = heardBy(cleo, "runtime-failure", card);
  assert.match(
    heard?.body ?? "",
    /\[YAML withheld: credential boundaries unclear\]\. Classified transient\./,
  );
  assert.match(heard?.body ?? "", /mode=retry\), eligible at/);
  assert.ok(Date.parse(eligibleAt(cleo, card) ?? "") >= before + 10_800_000, heard?.body);
  assert.doesNotMatch(heard?.body ?? "", /Request filter|rate limit exceeded/);
  await assert.rejects(
    restart(card, incident, { mode: "retry", key: "early" }),
    /is not eligible for recovery until/,
  );

  await reachedTier(cleo, card, "runtime-failure-open", 4);
  assert.deepEqual(heardBy(fleet.main, "runtime-failure-unrecoverable"), []);
});

async function noticeAfter(
  card: Card,
  diagnostic: string,
  recovering: boolean,
  description: string,
): Promise<{ incident: { incident: number; generation: number }; notice: Entry }> {
  const worker = await failingWorker(card, recovering ? "worker turn ended" : diagnostic);
  const incident = await incidentHeard(cleo);
  if (recovering) {
    await restart(card, incident, { mode: "retry", key: "first" });
    await worker.call("incident.report", { error: diagnostic });
  }
  const notice = await cleo.waitForEntry(
    (entry) =>
      is("runtime-failure")(entry) && (!recovering || entry.body.includes("did not verify")),
    description,
  );
  return { incident, notice };
}

function assertClippedExcerpt(body: string, recovering: boolean): void {
  const excerpt = recovering ? /did not verify: (.*?)\. Recover with/ : /failed: (.*?) Classified/;
  const displayed = excerpt.exec(body)?.[1];
  assert.ok(displayed?.endsWith("..."), body);
  assert.ok(displayed !== undefined);
  assert.equal(displayed.length, 603, body);
  assert.doesNotMatch(displayed, /quota headers|Retry-After/);
}

function assertEligibleAfter(body: string, before: number, delay: number): void {
  const eligible = Date.parse(ELIGIBLE_AT.exec(body)?.[1] ?? "");
  if (delay === 0) assert.ok(eligible >= before && eligible < before + 120_000, body);
  else assert.ok(eligible >= before + delay && eligible <= Date.now() + delay, body);
}

const LONG_DIAGNOSTIC_HEAD = String.raw`HTTP 429 revision 0123456789abcdef0123456789abcdef01234567 connection https:\/\/fixture:paper\u002Bcanoe@localhost\/path`;
for (const [name, diagnostic, visible, delay, mode = "retry", clipped = false] of [
  [
    "a quoted retry hint with an already scrubbed token",
    'HTTP 429 {"retry_after": 10800, "token": [hidden], "secretAccessKey": "fixture/403+paper/canoe", "SessionToken": "fixture/99999+paper/canoe="}',
    'HTTP 429 {"retry_after": 10800, "token": [hidden], "secretAccessKey": [hidden], "SessionToken": [hidden]}',
    10_800_000,
  ],
  [
    "a retry hint beyond the displayed diagnostic",
    `${LONG_DIAGNOSTIC_HEAD} ${"provider ".repeat(56)}quota headers were unavailable. Retry-After: 120`,
    String.raw`HTTP 429 revision 0123456789abcdef0123456789abcdef01234567 connection https:\/\/[hidden]@localhost\/path`,
    120_000,
    "retry",
    true,
  ],
  [
    "a leading retry hint with ambiguous URL userinfo",
    `429 Too Many Requests. Retry-After: 120\n${String.raw`https:\/\/fixture:paper\u002Zcanoe@localhost\/path`}`,
    "[URL withheld: credential boundaries unclear]",
    120_000,
  ],
  [
    "a separate retry header before a withheld body",
    "HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain\r\nRetry-After: 120\r\n\r\nRetry-After: 99999\r\n403 curl --user='demo:paper canoe",
    "[curl withheld: credential boundaries unclear]",
    120_000,
  ],
  [
    "a body-only retry hint after the HTTP headers",
    "HTTP/1.1 429 Too Many Requests\nContent-Type: text/plain\n\nRetry-After: 99999\ntoken: [paper, canoe]",
    "[YAML withheld: credential boundaries unclear]",
    0,
  ],
  [
    "a bare provider status with a withheld credential collection",
    "429 Too Many Requests. Retry-After: 120\ntoken:\n- 403 Retry-After: 99999 paper\n- canoe",
    "[YAML withheld: credential boundaries unclear]",
    120_000,
  ],
  [
    "a standard internal server error",
    "HTTP 500 Internal Server Error. Retry-After: 120\nSessionToken: [paper, 403 Retry-After: 99999 canoe]",
    "[YAML withheld: credential boundaries unclear]",
    120_000,
  ],
  [
    "a standard service-temporarily-unavailable response with a cookie",
    "HTTP/1.1 503 Service Temporarily Unavailable\nRetry-After: 120\nSet-Cookie: session=paper\n\n",
    "[credential record withheld: credential boundaries unclear]",
    120_000,
  ],
  [
    "a standard bad gateway error",
    "HTTP/1.1 502 Bad Gateway. Retry-After: 120\nSessionToken: [paper, 403 Retry-After: 99999 canoe]",
    "[YAML withheld: credential boundaries unclear]",
    120_000,
  ],
  [
    "a standard gateway timeout",
    "504 Gateway Timeout. Retry-After: 120\nSessionToken: [paper, 403 Retry-After: 99999 canoe]",
    "[YAML withheld: credential boundaries unclear]",
    120_000,
  ],
  [
    "a standard payment error",
    "402 Payment Required. Retry-After: 120\nSessionToken: [paper, 403 Retry-After: 99999 canoe]",
    "[YAML withheld: credential boundaries unclear]",
    120_000,
    "replace",
  ],
] as const) {
  for (const recovering of [false, true]) {
    test(`${name} ${delay > 0 ? "delays" : "does not delay"} ${recovering ? "further" : "initial"} recovery`, async () => {
      const card = await newCard(cleo, "Restore provider access");
      const before = Date.now();
      const { incident, notice } = await noticeAfter(
        card,
        diagnostic,
        recovering,
        "the incident with the provider retry hint",
      );
      assert.ok(notice.body.includes(visible), notice.body);
      assert.doesNotMatch(notice.body, /\b(?:403|99999)\b|paper|canoe/);
      if (clipped) assertClippedExcerpt(notice.body, recovering);
      assertEligibleAfter(notice.body, before, delay);
      const otherMode = mode === "retry" ? "replace" : "retry";
      await assert.rejects(
        restart(card, incident, { mode: otherMode, key: "wrong-mode" }),
        mode === "retry"
          ? /\(transient, turn\)\. Available: retry/
          : /\(vendor-quota, turn\)\. Available: replace/,
      );
      if (delay > 0)
        await assert.rejects(
          restart(card, incident, { mode, key: "too-early" }),
          /is not eligible for recovery until/,
        );
    });
  }
}

for (const [status, separator, recovering] of [
  ["HTTP/1.1 401 Unauthorized", "\r\n", false],
  ["403 Forbidden", "\r", true],
] as const) {
  test(`${status} stops ${recovering ? "further" : "initial"} recovery even with a withheld diagnostic`, async () => {
    const card = await newCard(cleo, "Restore provider authentication");
    const diagnostic = `\uFEFF${status}${separator}secretAccessKey: [paper, 402 Retry-After: 99999 canoe]`;
    const { incident, notice: heard } = await noticeAfter(
      card,
      diagnostic,
      recovering,
      "the authentication failure",
    );
    assert.match(heard.body, /: \[YAML withheld: credential boundaries unclear\]\./);
    assert.doesNotMatch(heard.body, /secretAccessKey|paper|canoe|99999|Retry-After/);
    for (const mode of ["retry", "replace"]) {
      await assert.rejects(
        restart(card, incident, { mode, key: `refused-${mode}` }),
        /incident \d+ is blocked: auth is not repaired by recovering/,
      );
    }
  });
}

test("a recovery that gets no response within the verification window fails and leaves a normal retry", async () => {
  const card = await newCard(cleo, "Users see one scrollbar");
  await failingWorker(card, "HTTP 529 overloaded");
  const incident = await incidentHeard(cleo);
  await cleo.waitForEntry(
    (entry) => is("runtime-failure")(entry) && entry.body.includes("is eligible for recovery now"),
    "the retry becoming eligible",
  );
  await restart(card, incident, { mode: "retry", key: "silent" });
  const failed = await cleo.waitForEntry(
    (entry) =>
      is("runtime-failure")(entry) &&
      entry.body.includes(
        "did not verify: no real response and action within the verification window",
      ),
    "the verification timeout notice",
  );
  assert.match(failed.body, /Recover with restart_card\([^)]*mode=retry\)/);
  await assert.rejects(
    restart(card, incident, { mode: "replace", key: "wrong-mode" }),
    /Available: retry/,
  );
});

test("a failure that needs no model refusal escalates when its retries are spent, and not before", async () => {
  const card = await newCard(cleo, "Users see one scrollbar");
  const worker = await failingWorker(
    card,
    "HTTP 529 overloaded\npassword: '403 Retry-After: 99999'",
  );
  const incident = await incidentHeard(cleo);
  const [initial] = heardBy(cleo, "runtime-failure", card);
  assert.match(initial?.body ?? "", /password: \[hidden\]\. Classified transient\./);
  assert.doesNotMatch(initial?.body ?? "", /\b(?:403|99999)\b/);
  const eligibleNotices = (): Entry[] =>
    heardBy(cleo, "runtime-failure", card).filter((entry) =>
      entry.body.includes("is eligible for recovery now"),
    );
  for (const attempt of [1, 2]) {
    const ready = await cleo.waitForEntry(
      (entry) => eligibleNotices()[attempt - 1]?.id === entry.id,
      `eligibility notice ${String(attempt)}`,
    );
    assert.deepEqual(heardBy(fleet.main, "runtime-failure-unrecoverable"), []);
    await restart(card, incident, { mode: "retry", key: `retry-${String(attempt)}` });
    await worker.call("incident.report", {
      error: "HTTP 529 overloaded\n- - token: '403 Retry-After: 99999 paper canoe'\n    next: yes",
    });
    const failure = await cleo.waitForEntry(
      (entry) =>
        entry.id > ready.id &&
        is("runtime-failure")(entry) &&
        entry.body.includes("did not verify"),
      "the withheld recovery diagnostic",
    );
    assert.match(failure.body, /did not verify: \[YAML withheld: credential boundaries unclear\]/);
    assert.doesNotMatch(failure.body, /paper canoe|\b(?:403|99999)\b|529 overloaded/);
  }

  const told = await fleet.main.waitForEntry(
    is("runtime-failure-unrecoverable"),
    "main to hear that the retries are spent",
  );
  assert.match(told.body, /every recovery its class allows is spent \(2 of 2 retries\)/);
  assert.ok(!told.body.includes("still pending"), told.body);
  assert.match(told.body, /c-\d+ in lane cleo, incident \d+/);
});

test("bad credentials leave no recovery from the start, and main hears once after the first reminder", async () => {
  const card = await newCard(cleo, "Users see one scrollbar");
  await failingWorker(card, "HTTP 401 invalid api key");

  const told = await fleet.main.waitForEntry(
    is("runtime-failure-unrecoverable"),
    "main to hear about bad credentials",
  );
  const firstReminder = await reachedTier(cleo, card, "runtime-failure-open", 1);
  assert.ok(told.id > firstReminder.id);
  assert.match(told.body, /restarting is not a repair for auth/);
  assert.ok(!told.body.includes("still pending"), told.body);
  await reachedTier(cleo, card, "runtime-failure-open", 4);
  assert.equal(heardBy(fleet.main, "runtime-failure-unrecoverable").length, 1);
});

test("a worker in main's own lane is not escalated: main is already its mate", async () => {
  const card = await newCard(fleet.main, "Users see one scrollbar");
  await failingWorker(card, "HTTP 401 invalid api key", { mate: fleet.main });

  await reachedTier(fleet.main, card, "runtime-failure-open", 3);
  assert.deepEqual(heardBy(fleet.main, "runtime-failure-unrecoverable"), []);
});
