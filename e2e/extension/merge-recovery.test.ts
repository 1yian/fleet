import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { CardViewSchema, check, HttpOutcomeSchema, type Entry } from "@fleet/protocol";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import { Scratch } from "../support/scratch.ts";

let parts: DispatchLab | undefined;
let scratch: Scratch | undefined;
afterEach(async (t) => {
  if (parts !== undefined) {
    await parts.lab.printIfFailed(t);
    await stopDispatchLab(parts);
  }
  scratch?.dispose();
});

async function start(): Promise<DispatchLab> {
  scratch = new Scratch();
  parts = await startDispatchLab({
    extension: join(scratch.root, "packages/extension/src/index.ts"),
    cardd: { CARDD_TIMING_SCALE: "0.02" },
  });
  return parts;
}

async function entries(p: DispatchLab): Promise<Entry[]> {
  const result = await p.cardd.post(p.mainToken, "card", { card: 1 });
  const outcome = check(HttpOutcomeSchema, result.body);
  if (!outcome.ok) throw new Error(outcome.error);
  return check(CardViewSchema, outcome.value).entries;
}

async function waitEntry(p: DispatchLab, body: string): Promise<Entry> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  for (;;) {
    const found = (await entries(p).catch(() => [])).find((entry) => entry.body.includes(body));
    if (found !== undefined) return found;
    assert.ok(Date.now() < deadline, `no entry containing ${body}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function dispatch(p: DispatchLab): void {
  p.h.onModel(() => ({ tool: "board", args: {} }), "mate");
  p.h.onModel(
    () => ({
      tool: "dispatch",
      args: {
        title: "Verify the deployment",
        name: "verify-deploy",
        kind: "ship",
        project: "site",
        intent: "Verify the deployment without deploying again",
        host: "local",
        task: "Preserve the merge authorization and verify only. Never deploy again.",
      },
    }),
    "mate",
  );
  p.h.onModel(() => ({ text: "dispatched" }), "mate");
}

const incidentOf = (body: string): { incident: number; generation: number } => {
  const match = /Incident (\d+), process generation (\d+)/.exec(body);
  assert.ok(match, body);
  return { incident: Number(match[1]), generation: Number(match[2]) };
};

for (const merged of [false, true]) {
  test(`active merging work recovers and acts on the same conversation when its PR is ${merged ? "merged" : "open"}`, async () => {
    const p = await start();
    const { h, mate, cardd, clone } = p;
    cardd.yolo("site");
    const pr = "https://github.com/acme/site/pull/12";
    cardd.gh.setPr(pr, merged ? "MERGED" : "OPEN");
    dispatch(p);
    let authorized = false;
    let requested = false;
    for (let call = 0; call < 12; call += 1)
      h.onModel((turns) => {
        const user = lastUser(turns) ?? "";
        if (user.includes("runtime failure") && !requested) {
          requested = true;
          const incident = incidentOf(user);
          const db = new DatabaseSync(cardd.db, { timeout: 5000 });
          db.prepare("UPDATE incidents SET intent = 'merging' WHERE id = ?").run(incident.incident);
          db.close();
          return {
            tool: "restart_card",
            args: { card: 1, ...incident, mode: "replace", key: "merge-recovery" },
          };
        }
        if (user.includes("done:") && !authorized) {
          authorized = true;
          return {
            tool: "comment",
            args: {
              card: 1,
              text: "Merge authorized. Preserve the deploy gate. Verification only if already merged; no additional deployment.",
            },
          };
        }
        return { text: "noted" };
      }, "mate");
    const dirty = join(`${clone}.worktrees/c-1-a1`, "verification.txt");
    let reported = false;
    for (let call = 0; call < 12; call += 1)
      h.onModel((turns) => {
        const user = lastUser(turns) ?? "";
        if (user.includes("recovery check"))
          return turns.at(-1)?.role === "toolResult"
            ? { text: "Verification remains pending; no deploy or merge repeated." }
            : {
                tool: "report",
                args: {
                  status: "note",
                  text: "Verification remains pending; no deploy or merge repeated.",
                },
              };
        if (user.includes("Merge authorized")) {
          writeFileSync(dirty, "verification checkpoint\n");
          return { fail: "Cannot find module '/old/pi/chunk.js' imported from /pi/main.js" };
        }
        if (reported) return { text: "ready" };
        reported = true;
        return {
          tool: "report",
          args: {
            status: "done",
            text: "Ready for authorized continuation",
            pr,
            ...(merged ? { merged: true } : {}),
          },
        };
      }, "worker");
    await mateConnected(h);
    mate.prompt("verify the deployment");
    const failure = await waitEntry(p, "Classified stale-module");
    assert.match(failure.body, /Recover with restart_card/);
    const recovered = await waitEntry(p, "answered the recovery check and acted");
    assert.match(recovered.body, /recovered \(replace\)/);
    assert.equal((await cardd.board()).cards.find((card) => card.id === 1)?.status, "merging");
    assert.equal(readFileSync(dirty, "utf8"), "verification checkpoint\n");
    const fresh =
      h.callsOf("worker").findLast((turns) => lastUser(turns)?.includes("recovery check")) ?? [];
    assert.ok(
      fresh.some((turn) => turn.text.includes("Merge authorized. Preserve the deploy gate.")),
    );
    assert.ok(fresh.some((turn) => turn.text.includes("Never deploy again.")));
    const duplicate = await cardd.post(p.mainToken, "card.restart", {
      card: 1,
      ...incidentOf(failure.body),
      mode: "replace",
      key: "merge-recovery",
    });
    assert.equal(duplicate.status, 200);
    assert.equal(
      (await entries(p)).filter((entry) => entry.body.includes("recovered (replace)")).length,
      1,
    );
    const stale = await cardd.post(p.mainToken, "card.restart", {
      card: 1,
      ...incidentOf(failure.body),
      mode: "replace",
      key: "stale",
    });
    assert.equal(stale.status, 400);
  });
}

for (const state of ["paused", "done", "merged"] as const) {
  test(`${state} work remains protected from incident and ordinary replacement`, async () => {
    const p = await start();
    if (state !== "paused") p.cardd.yolo("site");
    const pr = "https://github.com/acme/site/pull/12";
    p.cardd.gh.setPr(pr, "MERGED");
    dispatch(p);
    for (let call = 0; call < 6; call += 1) p.h.onModel(() => ({ text: "noted" }), "mate");
    p.h.onModel(
      () => ({
        tool: "report",
        args: {
          status: state === "merged" ? "done" : state,
          text: "Do not resume",
          ...(state === "merged" ? { pr, merged: true } : {}),
          ...(state === "paused" ? { until: new Date(Date.now() + 3_600_000).toISOString() } : {}),
        },
      }),
      "worker",
    );
    p.h.onModel(
      () => ({ fail: "Cannot find module '/old/pi/chunk.js' imported from /pi/main.js" }),
      "worker",
    );
    await mateConnected(p.h);
    p.mate.prompt("verify the deployment");
    const failure = await waitEntry(p, "Classified stale-module");
    assert.match(
      failure.body,
      new RegExp(`Its card is ${state === "paused" ? "paused" : "completed"}`),
    );
    for (const incident of [false, true]) {
      const refused = await p.cardd.post(p.mainToken, "card.restart", {
        card: 1,
        mode: "replace",
        key: `protected-${String(incident)}`,
        ...(incident ? incidentOf(failure.body) : {}),
      });
      assert.equal(refused.status, 400);
      assert.match(JSON.stringify(refused.body), /never resumes/);
    }
  });
}

test("a pause during authorized merging still protects the worker", async () => {
  const p = await start();
  p.cardd.yolo("site");
  dispatch(p);
  let asked = false;
  for (let call = 0; call < 8; call += 1)
    p.h.onModel((turns) => {
      if (!asked && lastUser(turns)?.includes("done:")) {
        asked = true;
        return {
          tool: "comment",
          args: { card: 1, text: "Pause verification until the deploy gate clears" },
        };
      }
      return { text: "noted" };
    }, "mate");
  let done = false;
  for (let call = 0; call < 8; call += 1)
    p.h.onModel((turns) => {
      if (turns.at(-1)?.role === "toolResult") return { text: "waiting" };
      if (!done) {
        done = true;
        return { tool: "report", args: { status: "done", text: "Ready" } };
      }
      return {
        tool: "report",
        args: {
          status: "paused",
          text: "Deploy gate still closed",
          until: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    }, "worker");
  await mateConnected(p.h);
  p.mate.prompt("verify the deployment");
  await waitEntry(p, "Deploy gate still closed");
  const refused = await p.cardd.post(p.mainToken, "card.restart", {
    card: 1,
    mode: "replace",
    key: "paused-merge",
  });
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(refused.body), /the card is paused/);
});
