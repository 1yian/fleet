import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import type { Session } from "../support/cardd.ts";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness, type Turn } from "../support/harness.ts";
import { Scratch } from "../support/scratch.ts";

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

async function mainCalls(
  calls: readonly (readonly [string, Args])[],
  extension = EXTENSION,
  lane?: string,
): Promise<string[]> {
  for (const [tool, args] of calls) h.onModel(() => ({ tool, args }));
  h.onModel(() => ({ text: "read" }));
  const env = {
    FLEET_URL: fleet.cardd.url,
    FLEET_TOKEN: fleet.mainToken,
    FLEET_ROLE: "mate",
    ...(lane === undefined ? {} : { FLEET_LANE: lane }),
  };
  const mate = h.startPi("main", env, [extension]);
  await h.waitFor((e) => e["type"] === "fleet_connected", "the mate to connect");
  mate.prompt("What is on the board?");
  return toolResults(await h.waitForCall(calls.length));
}

test("main changes project yolo on the captain's word and the board reflects it", async () => {
  const scratch = new Scratch();
  try {
    const worker = await fleet.cardd.connect(
      await begin(fleet.main, await newCard(fleet.main, "Check worker authority")),
    );
    await assert.rejects(worker.call("project.yolo", { project: "web", on: true }), {
      message: "worker sessions cannot call project.yolo",
    });
    const results = await mainCalls(
      [
        ["project_yolo", { project: "web", on: true }],
        ["board", {}],
        ["project_yolo", { project: "web", on: false }],
        ["board", {}],
      ],
      `${scratch.root}/packages/extension/src/index.ts`,
      "main",
    );
    assert.match(results[0] ?? "", /web: yolo on/);
    assert.match(results[1] ?? "", /web,no-mistakes,maverick p620,on/);
    assert.match(results[2] ?? "", /web: yolo off/);
    assert.match(results[3] ?? "", /web,no-mistakes,maverick p620,off/);
    const token = fleet.cardd.addLane("cleo", "main");
    for (const on of [true, false]) {
      assert.deepEqual(await fleet.cardd.post(token, "project.yolo", { project: "web", on }), {
        status: 400,
        body: { ok: false, error: "only main can change a project's yolo flag" },
      });
    }
  } finally {
    scratch.dispose();
  }
});

test("a second mate is not offered project_yolo", async () => {
  const scratch = new Scratch();
  try {
    const token = fleet.cardd.addLane("cleo", "main");
    h.onModel(() => ({ tool: "project_yolo", args: { project: "web", on: true } }));
    h.onModel(() => ({ text: "refused" }));
    const mate = h.startPi(
      "cleo",
      { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "mate", FLEET_LANE: "cleo" },
      [`${scratch.root}/packages/extension/src/index.ts`],
    );
    await h.waitFor((e) => e["type"] === "fleet_connected", "the second mate to connect");
    mate.prompt("Try setting project yolo");
    assert.match(toolResults(await h.waitForCall(1))[0] ?? "", /Tool project_yolo not found/);
    assert.equal(check(OPS.projects.result, await fleet.main.call("projects", {}))[0]?.yolo, false);
  } finally {
    scratch.dispose();
  }
});

const LONG_NOTE = `${"The scrollbar doubles because the panel and the page both scroll. ".repeat(6)}Report written: /tmp/scrollbar-report.md.`;

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

interface BoardActor {
  lane: string;
  token: string;
  mate: Session;
}

type LaneActor = BoardActor & { card: { id: number; title: string } };

async function checkLaneBoard(
  scratch: Scratch,
  actor: BoardActor,
  lanes: LaneActor[],
): Promise<void> {
  const harness = await Harness.start();
  try {
    for (const args of [
      {},
      { lanes: true, projects: true },
      ...lanes.map(({ card }) => ({ card: card.id })),
    ])
      harness.onModel(() => ({ tool: "board", args }));
    harness.onModel(() => ({ text: "read" }));
    const pi = harness.startPi(
      actor.lane,
      {
        FLEET_URL: fleet.cardd.url,
        FLEET_TOKEN: actor.token,
        FLEET_ROLE: "mate",
      },
      [`${scratch.root}/packages/extension/src/index.ts`],
    );
    await harness.waitFor((event) => event["type"] === "fleet_connected", "mate connected");
    pi.prompt("Read my board and both cards");
    const results = toolResults(await harness.waitForCall(4));
    const mate = await fleet.cardd.connect(actor.token);
    try {
      await checkLaneResults({ ...actor, mate }, lanes, results);
    } finally {
      await mate.close();
    }
  } finally {
    await harness.stop();
  }
}

async function checkLaneResults(
  actor: BoardActor,
  lanes: LaneActor[],
  results: string[],
): Promise<void> {
  const [board = "", header = "", ...details] = results;
  assert.match(header, /web,no-mistakes,main,maverick p620,off/);
  assert.match(board, actor.lane === "main" ? /^open: "4 /m : /^open: "2 /m);
  assert.match(
    board,
    actor.lane === "main" ? /^closed: 2 \(done 2\)$/m : /^closed: 1 \(done 1\)$/m,
  );
  if (actor.lane !== "main") assert.doesNotMatch(header, /^lanes\[/m);
  const visible = check(OPS.board.result, await actor.mate.call("board", {}));
  for (const [index, other] of lanes.entries()) {
    if (actor.lane === "main" || actor.lane === other.lane) {
      assert.ok(board.includes(other.card.title));
      assert.match(String(details[index]), new RegExp(`title: ${other.card.title}`));
      assert.ok(visible.some((card) => card.id === other.card.id));
    } else {
      assert.ok(!board.includes(other.card.title));
      assert.ok(visible.every((card) => card.lane === actor.lane));
      assert.match(String(details[index]), /is in another lane; ask main/);
      await assert.rejects(
        actor.mate.call("card", { card: other.card.id }),
        /is in another lane; ask main/,
      );
    }
  }
}

test("second mates see only their own lane through board and cardd, including the fleet mate", async () => {
  const scratch = new Scratch();
  try {
    const lanes = [];
    for (const lane of ["leo", "fleet"]) {
      const token = fleet.cardd.addLane(lane, "main");
      const mate = await fleet.cardd.connect(token);
      const card = await newCard(mate, `${lane} private work`, "scout");
      const closed = await newCard(mate, `${lane} finished work`, "scout");
      await mate.call("close.finish", {
        card: closed.id,
        mode: "done",
        text: "Finished",
        archives: [],
        left: [],
      });
      lanes.push({ lane, token, mate, card });
    }
    for (const actor of [
      ...lanes,
      {
        lane: "main",
        token: fleet.mainToken,
        mate: fleet.main,
      },
    ]) {
      await checkLaneBoard(scratch, actor, lanes);
    }
    for (const { mate } of lanes) await mate.close();
    assert.equal((await fleet.cardd.board()).cards.length, 6);
  } finally {
    scratch.dispose();
  }
});

test("board shows the open cards by what needs attention, and counts the closed ones", async () => {
  const sessions = await seed();
  const [board] = await mainCalls([["board", {}]]);
  assert.equal(
    board,
    [
      "projects[1]{name,delivery,hosts,yolo}:",
      "  web,no-mistakes,maverick p620,off",
      'open: "5 (needs-you 1, with-mate 1, working 1, queued 1, waiting 1)"',
      'closed: "2 (done 1, dropped 1)"',
      "cards[5]{card,status,waits,delivery,title}:",
      "  2,needs-you,captain,none,Pick the API version",
      "  7,with-mate,main,report,Pick an ad channel",
      "  3,working,worker,no-mistakes,Fix the scrollbar",
      "  4,queued,main,no-mistakes,Write the docs",
      "  1,waiting,cleo,none,cleo",
      "help[3]:",
      "  Call `board(card=<card>)` to read a card: its hold, PR, branch, and thread",
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
    /^cards\[1\]\{card,status,waits,delivery,title\}:\n {2}6,dropped,nobody,report,Try the old banner$/m,
  );
  assert.equal(
    cleo,
    [
      "projects[1]{name,delivery,hosts,yolo}:",
      "  web,no-mistakes,maverick p620,off",
      "lane: cleo",
      'open: "2 (with-mate 1, waiting 1)"',
      "closed: 0",
      "cards[2]{card,status,waits,delivery,title}:",
      "  7,with-mate,main,report,Pick an ad channel",
      "  1,waiting,cleo,none,cleo",
      "help[2]:",
      "  Call `board(card=<card>)` to read a card: its hold, PR, branch, and thread",
      '  Call `board(fields="lane,pr")` for more columns: name, lane, kind, project, pr, summary, updated',
    ].join("\n"),
  );
  assert.match(capped ?? "", /^hidden: 1 older closed cards$/m);
  assert.match(capped ?? "", /^cards\[1\]\{card,status,waits,delivery,title\}:$/m);
  assert.match(
    capped ?? "",
    /^ {2}Call `board\(status="closed", limit=<n>\)` to list more closed cards$/m,
  );
  assert.match(
    fields ?? "",
    /^cards\[1\]\{card,status,waits,delivery,title,lane,summary\}:\n {2}3,working,worker,no-mistakes,Fix the scrollbar,main,"The scrollbar doubles because/m,
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
  const header = "projects[1]{name,delivery,hosts,yolo}:\n  web,no-mistakes,maverick p620,off\n";
  assert.equal(board, `${header}open: 0\nclosed: 0\ncards: 0 open cards`);
  assert.equal(lane, `${header}lane: cleo\nopen: 0\nclosed: 0\ncards: 0 cards in lane cleo`);
});

test("board(card=N) shows one card's hold, attempt, report, and thread, cut until full", async () => {
  const sessions = await seed();
  const [scroll, whole, api, missing] = await mainCalls([
    ["board", { card: 3 }],
    ["board", { card: 3, full: true, entries: 1 }],
    ["board", { card: 2 }],
    ["board", { card: 99 }],
  ]);
  const view = scroll ?? "";
  assert.match(
    view,
    /^card:\n {2}id: 3\n {2}name: fix-the-scrollbar\n {2}title: Fix the scrollbar\n {2}kind: ship\n {2}project: web\n {2}delivery: no-mistakes\n {2}lane: main\n {2}status: working\n {2}waits: worker\n {2}pr: none\n/,
  );
  assert.match(view, /^attempts\[1\]\{n,host,state,branch\}:\n {2}1,maverick,active,\S*c-3-a1$/m);
  assert.match(view, /^report: \/tmp\/scrollbar-report\.md$/m);
  assert.doesNotMatch(view, /^(hold|intent|spec):/m);
  assert.match(
    view,
    /^entries\[2\]\{id,age,from,kind,body\}:\n {2}\d+,\d+s ago,"worker:c-3-a1",report\/working,"The scrollbar doubles[^"\n]*\.\.\. \(truncated, 437 chars total, full=true shows all\)"\n {2}\d+,\d+s ago,"mate:main",comment,"Fix the double scrollbar\\n\\nDelivery: no-mistakes"$/m,
  );
  assert.match(view, /^ {2}Call `board\(card=3, full=true\)` to see every text whole$/m);

  assert.ok((whole ?? "").includes(LONG_NOTE));
  assert.match(whole ?? "", /^hidden: 1 older entries$/m);
  assert.match(whole ?? "", /^ {2}Call `board\(card=3, entries=2\)` to read the whole thread$/m);

  assert.match(
    api ?? "",
    /^hold:\n {2}waits: captain\n {2}question: v1 or v2\?\n {2}options\[2\]: v2,v1$/m,
  );
  assert.match(api ?? "", /^attempts: 0 \(never dispatched\)$/m);
  assert.doesNotMatch(api ?? "", /full=true/);
  assert.equal(missing, "error: no card c-99\nhelp[1]:\n  Call `board()` to list the open cards");
  await Promise.all([sessions.cleo.close(), sessions.worker.close()]);
});

test("board lists every project with board(projects=true), and past 8 projects the header keeps those in use or with yolo on", async () => {
  for (const name of ["api", "app", "docs", "infra", "ios", "site", "tools", "www"])
    fleet.cardd.addProject(name, { maverick: `/clones/${name}` });
  fleet.cardd.yolo("ios");
  await newCard(fleet.main, "Fix the scrollbar");
  const [header, every] = await mainCalls([
    ["board", {}],
    ["board", { projects: true }],
  ]);
  assert.match(
    header ?? "",
    /^projects\[2\]\{name,delivery,hosts,yolo\}:\n {2}ios,no-mistakes,maverick,on\n {2}web,no-mistakes,maverick p620,off\n/,
  );
  assert.match(
    header ?? "",
    /^ {2}Call `board\(projects=true\)` to list 7 more projects, with their base branch$/m,
  );
  assert.match(
    every ?? "",
    /^projects\[9\]\{name,delivery,base,hosts,yolo\}:\n {2}api,no-mistakes,main,maverick,off$/m,
  );
  assert.doesNotMatch(every ?? "", /projects=true/);
});
