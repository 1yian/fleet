import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CardViewSchema, check, HttpOutcomeSchema } from "@fleet/protocol";
import {
  lastUser,
  mateConnected,
  startDispatchLab,
  stopDispatchLab,
  WORKER_WAIT_MS,
  type DispatchLab,
} from "../support/dispatch-lab.ts";
import type { Move, Turn } from "../support/harness.ts";
import { git, tip } from "../support/remote.ts";
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

const prOf = (card: number) => `https://github.com/acme/site/pull/${String(card)}`;
const treeOf = (p: DispatchLab, card: number) => `${p.clone}.worktrees/c-${String(card)}-a1`;

function dispatchPart(card: number): Move {
  return {
    tool: "dispatch",
    args: {
      title: `Part ${String(card)} of the outcome`,
      name: `outcome-part-${String(card)}`,
      kind: "ship",
      project: "site",
      intent: "Deliver both independent parts",
      host: "local",
      task: `Deliver only part ${String(card)}. The other part has its own ship card. ${card === 2 ? "Linked to c-1." : "Continuation will be c-2."}`,
    },
  };
}

function mateMove(): (turns: Turn[]) => Move {
  let dispatched = 0;
  return (turns) => {
    const last = turns.at(-1)?.role;
    const user = lastUser(turns) ?? "";
    if (user.includes("Create both parts")) {
      if (last === "user" && dispatched === 0) {
        dispatched = 1;
        return dispatchPart(1);
      }
      if (last !== "user" && dispatched === 1) {
        dispatched = 2;
        return dispatchPart(2);
      }
    }
    if (last !== "user") return { text: "recorded" };
    return approveMove(user);
  };
}

function approveMove(user: string): Move {
  const approved = /captain on c-([12]).*\(answer\): Approve & merge/.exec(user);
  if (approved !== null)
    return {
      tool: "comment",
      args: { card: Number(approved[1]), text: "Merge only your own PR now with green checks." },
    };
  return { text: "recorded" };
}

function workerScript(p: DispatchLab): (turns: Turn[]) => Move {
  const staged = new Map<number, number>();
  return (turns) => {
    const user = lastUser(turns) ?? "";
    const match = /on c-([12])\b/.exec(user);
    assert.ok(match, user);
    const card = Number(match[1]);
    const stage = staged.get(card) ?? 0;
    if (user.includes("Merge only") && stage === 2) {
      execFileSync("gh", ["pr", "merge", prOf(card), "--squash"], {
        env: { ...process.env, ...p.cardd.gh.env },
      });
      staged.set(card, 3);
      return { tool: "report", args: { status: "merged", text: "part merged", pr: prOf(card) } };
    }
    if (stage === 0) {
      staged.set(card, 1);
      return { tool: "branch", args: { name: `feat/outcome-part-${String(card)}` } };
    }
    if (stage === 1) {
      const tree = treeOf(p, card);
      writeFileSync(join(tree, "part.txt"), `part ${String(card)}\n`);
      git(tree, "add", "part.txt");
      git(tree, "commit", "-qm", `part ${String(card)}`);
      writeFileSync(join(tree, "notes.txt"), `pending notes ${String(card)}\n`);
      p.cardd.gh.setPr(prOf(card), "OPEN");
      staged.set(card, 2);
      return {
        tool: "report",
        args: { status: "done", text: "own PR checks green", pr: prOf(card) },
      };
    }
    return { text: "reported" };
  };
}

async function view(p: DispatchLab, card: number) {
  const response = await p.cardd.post(p.mainToken, "card", { card });
  const outcome = check(HttpOutcomeSchema, response.body);
  assert.ok(outcome.ok);
  return check(CardViewSchema, outcome.value);
}

async function waitEntry(p: DispatchLab, card: number, kind: string): Promise<void> {
  const deadline = Date.now() + WORKER_WAIT_MS;
  for (;;) {
    const found = await view(p, card).catch(() => undefined);
    if (found?.entries.some((entry) => entry.kind === kind)) return;
    assert.ok(Date.now() < deadline, `c-${String(card)} has no ${kind}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function approve(p: DispatchLab, card: number): Promise<void> {
  const hold = (await p.cardd.board()).holds.find((each) => each.card === card);
  assert.ok(hold);
  assert.ok(hold.question.includes(prOf(card)));
  assert.equal(
    await p.cardd.act(card, { kind: "answer", hold: hold.hold, choice: "Approve & merge" }),
    200,
  );
}

test("linked ship cards deliver one outcome without closing or approving the pending PR", async () => {
  scratch = new Scratch();
  const p = await startDispatchLab({
    extension: join(scratch.root, "packages/extension/src/index.ts"),
  });
  parts = p;
  const worker = workerScript(p);
  const mate = mateMove();
  for (let call = 0; call < 60; call += 1) {
    p.h.onModel(mate, "mate");
    p.h.onModel(worker, "worker");
  }
  await mateConnected(p.h);
  p.mate.prompt("Create both parts");
  await waitEntry(p, 1, "report");
  await waitEntry(p, 2, "report");
  const board = await p.cardd.board();
  assert.equal(board.cards.find((c) => c.id === 2)?.pr, prOf(2));
  assert.equal(board.holds.find((h) => h.card === 2)?.merge, true);
  const before = tip(treeOf(p, 2), "HEAD");
  await approve(p, 1);
  await waitEntry(p, 1, "cleanup");
  assert.equal((await view(p, 1)).card.status, "done");
  assert.equal(existsSync(treeOf(p, 1)), false);
  assert.equal(p.cardd.gh.state(prOf(1)), "MERGED");
  assert.equal(p.cardd.gh.state(prOf(2)), "OPEN");
  assert.equal((await view(p, 2)).card.status, "needs-you");
  assert.equal(tip(treeOf(p, 2), "HEAD"), before);
  assert.equal(readFileSync(join(treeOf(p, 2), "part.txt"), "utf8"), "part 2\n");
  assert.equal(readFileSync(join(treeOf(p, 2), "notes.txt"), "utf8"), "pending notes 2\n");
  assert.ok(existsSync(`${p.clone}.archive/c-1-a1.tar.zst`));
  const refused = check(
    HttpOutcomeSchema,
    (await p.cardd.post(p.mainToken, "close.begin", { card: 2 })).body,
  );
  assert.ok(!refused.ok);
  assert.match(refused.error, /open hold/);
  assert.equal((await p.cardd.board()).holds.find((h) => h.card === 2)?.merge, true);
  await approve(p, 2);
  await waitEntry(p, 2, "cleanup");
  assert.equal((await view(p, 2)).card.status, "done");
  assert.equal(p.cardd.gh.state(prOf(2)), "MERGED");
  assert.equal(existsSync(treeOf(p, 2)), false);
  assert.ok(existsSync(`${p.clone}.archive/c-2-a1.tar.zst`));
});
