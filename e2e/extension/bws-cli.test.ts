import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { FakeBws, filesHolding } from "../support/bws.ts";
import { Scratch } from "../support/scratch.ts";
import { pathWithout } from "../support/tool-stubs.ts";

const GH_VALUE = `ghp_${randomUUID()}`;
const REFUSED_TOKEN = `0.${randomUUID()}.refused`;
const STALE_TOKEN = "stale-token-in-the-lane-file";
const KEY = "FLEET_LANE_TOKEN";

let cardd: Cardd;
let scratch: Scratch;
let bws: FakeBws;
let laneToken: string;
let home: string;
beforeEach(() => {
  return Cardd.start().then((started) => {
    cardd = started;
    cardd.addLane("main");
    laneToken = cardd.addLane("ops", "main");
    scratch = new Scratch();
    bws = new FakeBws([
      { name: "ops", secrets: { [KEY]: laneToken, GH_TOKEN: GH_VALUE } },
      { name: "Common", secrets: {} },
    ]);
    home = scratch.addLane("ops", { url: cardd.url, token: STALE_TOKEN });
  });
});
afterEach(async () => {
  await cardd.stop();
  scratch.dispose();
});

const settings = (more: Record<string, unknown> = {}): Record<string, unknown> => ({
  tokenFile: bws.tokenFile,
  project: "ops",
  common: "Common",
  ...more,
});

function configure(token: string | undefined, bwsBlock: unknown): void {
  const lane = { lane: "ops", url: cardd.url, token, bws: bwsBlock };
  writeFileSync(join(home, "config", "lane.json"), JSON.stringify(lane));
}

function fleet(
  args: readonly string[],
  env: Record<string, string> = bws.env,
): { status: number | null; out: string; err: string } {
  const run = spawnSync("node", [scratch.launch, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

async function wakeLanded(note: string): Promise<boolean> {
  for (const card of (await cardd.board()).cards) {
    const thread = await cardd.thread(card.id);
    if (thread.entries.some((entry) => entry.body === `script wake e2e: ${note}`)) return true;
  }
  return false;
}

function wake(note: string, env?: Record<string, string>): ReturnType<typeof fleet> {
  return fleet(["wake", "ops", note, "--script", "e2e"], env);
}

function assertNoLeak(secret: string, ...shown: string[]): void {
  for (const text of shown) assert.ok(!text.includes(secret), `the secret shows in:\n${text}`);
  assert.deepEqual(filesHolding(secret), [], "the secret was written to a file");
  assert.ok(!cardd.output.includes(secret), "the secret is in cardd's output");
  const argv = bws.calls().flatMap((call) => call.args);
  assert.ok(
    argv.every((arg) => !arg.includes(secret) && !arg.includes(bws.accessToken)),
    "a value is in the argv of bws",
  );
  assert.ok(
    bws.calls().every((call) => call.token),
    "bws ran without its access token",
  );
}

test("fleet wake takes the lane token from bws, so a stale token in the file is never sent", async () => {
  configure(STALE_TOKEN, settings());
  const run = wake("from bws");
  assert.equal(run.status, 0, run.err);
  assert.match(run.out, /ops: woken/);
  assert.equal(run.err.trim(), "fleet: lane token: from bws (key FLEET_LANE_TOKEN in project ops)");
  assert.ok(await wakeLanded("from bws"));
  assertNoLeak(laneToken, run.out, run.err);
  assert.ok(!run.err.includes(bws.accessToken) && !run.out.includes(bws.accessToken));
});

test("a lane whose file has no token at all works from bws, and the setup command can make one", async () => {
  const made = scratch.addLane("cleo", { url: cardd.url, bws: settings() });
  const file: unknown = JSON.parse(readFileSync(join(made, "config", "lane.json"), "utf8"));
  assert.ok(typeof file === "object" && file !== null && !("token" in file));
  configure(undefined, settings());
  const run = wake("no file token");
  assert.equal(run.status, 0, run.err);
  assert.ok(await wakeLanded("no file token"));
  assertNoLeak(laneToken, run.out, run.err);

  const missing = fleet(["secrets", "ops"], { PATH: pathWithout() });
  assert.equal(missing.status, 1);
  assert.equal(
    missing.out.trim(),
    "ops: lane token: bws failed (bws is not on the PATH), and config/lane.json has no token",
  );
});

test("a secret id, and a key found only in the common project, both resolve", () => {
  const fresh = new FakeBws([
    { name: "ops", secrets: {} },
    { name: "Common", secrets: { [KEY]: laneToken } },
  ]);
  bws = fresh;
  configure(STALE_TOKEN, settings());
  const common = wake("from common");
  assert.equal(common.status, 0, common.err);
  assert.match(common.err, /lane token: from bws \(key FLEET_LANE_TOKEN in project Common\)/);

  configure(STALE_TOKEN, settings({ laneToken: bws.secretId("Common", KEY) }));
  const byId = wake("by id");
  assert.equal(byId.status, 0, byId.err);
  assert.match(byId.err, /lane token: from bws \(secret id [0-9a-f-]{36}\)/);
  assert.ok(bws.calls().some((call) => call.args.includes("get")));
  assertNoLeak(laneToken, common.out, common.err, byId.out, byId.err);
});

const outages: {
  name: string;
  setUp: () => Record<string, string>;
  note: RegExp;
  settings?: () => Record<string, unknown>;
}[] = [
  {
    name: "bws is not installed",
    setUp: () => ({ PATH: pathWithout() }),
    note: /\(bws failed: bws is not on the PATH\)/,
  },
  {
    name: "bws is down",
    setUp: () => {
      bws.failWith("Error: simulated outage");
      return bws.env;
    },
    note: /\(bws failed: bws exited with status 1: Error: simulated outage\)/,
  },
  {
    name: "the secret is not in bws",
    setUp: () => {
      bws = new FakeBws([
        { name: "ops", secrets: { OTHER: "x" } },
        { name: "Common", secrets: {} },
      ]);
      return bws.env;
    },
    note: /\(bws failed: no key FLEET_LANE_TOKEN in project ops, no key FLEET_LANE_TOKEN in project Common\)/,
  },
  {
    name: "the project is not visible to the machine account",
    setUp: () => {
      bws = new FakeBws([{ name: "elsewhere", secrets: { [KEY]: "x" } }]);
      return bws.env;
    },
    note: /\(bws failed: project ops is not visible to this token, project Common is not visible to this token\)/,
  },
  {
    name: "the token file is missing",
    setUp: () => bws.env,
    settings: () => ({ tokenFile: join(scratch.parent, "no-such.token") }),
    note: /\(bws failed: the token file .*no-such\.token is missing or unreadable\)/,
  },
  {
    name: "the token file is readable by others",
    setUp: () => {
      chmodSync(bws.tokenFile, 0o644);
      return bws.env;
    },
    note: /\(bws failed: the token file .* must be mode 600\)/,
  },
  {
    name: "bws refuses the access token",
    setUp: () => {
      writeFileSync(bws.tokenFile, REFUSED_TOKEN);
      chmodSync(bws.tokenFile, 0o600);
      return bws.env;
    },
    note: /\(bws failed: bws exited with status 1: Error: \[401 Unauthorized\] the access token \[hidden\] was refused\)/,
  },
];

for (const { name, setUp, note, settings: tokenFile } of outages) {
  test(`when ${name}, fleet wake falls back to the lane file and says so`, async () => {
    const env = setUp();
    configure(laneToken, settings(tokenFile?.()));
    const run = wake(`fallback ${name}`, env);
    assert.equal(run.status, 0, run.err);
    assert.match(run.err, /^fleet: lane token: from config\/lane\.json /);
    assert.match(run.err, note);
    assert.ok(await wakeLanded(`fallback ${name}`));
    assert.ok(!run.err.includes(bws.accessToken), "the machine token shows in the note");
    assert.ok(!run.err.includes(REFUSED_TOKEN), "the refused token shows in the note");
  });
}

test("with no token anywhere, fleet wake refuses and says where it looked", () => {
  configure(undefined, settings());
  bws.failWith("Error: simulated outage");
  const run = wake("nothing", bws.env);
  assert.notEqual(run.status, 0);
  assert.match(
    run.err,
    /fleet: lane token: not found \(bws failed: bws exited with status 1: Error: simulated outage, and config\/lane\.json has none\)/,
  );
});

test("fleet secrets tells the captain, line by line, what bws serves before the old file goes", () => {
  configure(laneToken, settings({ env: { GH_TOKEN: "GH_TOKEN" } }));
  const same = fleet(["secrets"]);
  assert.equal(same.status, 0, same.err);
  assert.equal(
    same.out.trim(),
    [
      "ops: lane token: bws ok (key FLEET_LANE_TOKEN in project ops), the same as config/lane.json",
      "ops: GH_TOKEN: bws ok (key GH_TOKEN in project ops)",
    ].join("\n"),
  );

  configure(STALE_TOKEN, settings());
  const different = fleet(["secrets", "ops"]);
  assert.equal(different.status, 0);
  assert.match(
    different.out,
    /bws ok \(key FLEET_LANE_TOKEN in project ops\), different from config\/lane\.json/,
  );

  configure(STALE_TOKEN, settings({ env: { GH_TOKEN: "NO_SUCH_KEY" } }));
  const broken = fleet(["secrets", "ops"]);
  assert.equal(broken.status, 1);
  assert.match(
    broken.out,
    /ops: GH_TOKEN: bws failed \(no key NO_SUCH_KEY in project ops, no key NO_SUCH_KEY in project Common\)/,
  );
  assertNoLeak(GH_VALUE, same.out, different.out, broken.out, broken.err);
  assertNoLeak(laneToken, same.out, different.out, broken.out);
});

test("a lane without a bws block behaves as before and prints no note", async () => {
  configure(laneToken, undefined);
  const run = wake("plain");
  assert.equal(run.status, 0, run.err);
  assert.equal(run.err, "");
  assert.ok(await wakeLanded("plain"));
  assert.deepEqual(bws.calls(), [], "bws was run for a lane that does not use it");
  const checked = fleet(["secrets", "ops"]);
  assert.equal(checked.status, 0);
  assert.equal(
    checked.out.trim(),
    "ops: no bws block, so the lane token comes from config/lane.json",
  );
});

test("a bws block that names no project is refused with the file it is in", () => {
  configure(laneToken, { tokenFile: bws.tokenFile });
  const run = wake("bad block");
  assert.notEqual(run.status, 0);
  assert.match(run.err, /lane\.json: "bws" needs "tokenFile" and "project"/);
});
