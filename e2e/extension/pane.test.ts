import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CardSchema, check } from "@fleet/protocol";
import { Cardd } from "../support/cardd.ts";
import { Harness } from "../support/harness.ts";
import { HerdrLab } from "../support/herdr.ts";
import { configureMain, Scratch, startMain } from "../support/scratch.ts";

const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const EVIDENCE = process.env["PANE_EVIDENCE_DIR"];

function keep(name: string, screen: string): void {
  if (EVIDENCE === undefined) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, `${name}.txt`), screen);
}

async function screenWith(lab: HerdrLab, pane: string, text: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const screen = await lab.screen(pane);
    if (screen.includes(text)) return screen;
    assert.ok(Date.now() < deadline, `waiting for ${text}:\n${screen}`);
  }
}

function originalPane(screen: string): void {
  assert.doesNotMatch(screen, /◆|◇|▲|✓ clear|Decision 1 of|needs you|Pulse ·/);
  assert.doesNotMatch(screen, /^[●] /m);
}

test("original terminal keeps decisions in chat and on the board, not a strip or status counts", async (context) => {
  const scratch = new Scratch();
  const cardd = await Cardd.start();
  const h = await Harness.start();
  const token = cardd.addLane("main", undefined, scratch.root);
  configureMain(scratch, cardd.url, token);
  const main = await cardd.connect(token);
  const card = check(
    CardSchema,
    await main.call("card.new", { title: "Release choice", kind: "captain" }),
  );
  const lab = await HerdrLab.start({
    ...h.piEnv("mate"),
    PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
  });
  try {
    const pane = await startMain(lab, scratch, h);
    const base = cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");
    const clear = await screenWith(lab, pane, base);
    originalPane(clear);
    keep("1-original-footer", clear);
    assert.equal(
      (
        await cardd.post(token, "hold", {
          card: card.id,
          question: "Use the short name?",
          options: ["Yes", "No"],
        })
      ).status,
      200,
    );
    h.onModel(() => ({ text: "Captain, use the short name? I recommend yes." }), "mate");
    await lab.submit(pane, "What needs my decision?");
    const held = await screenWith(lab, pane, "I recommend yes.");
    originalPane(held);
    keep("2-chat-question", held);
    const hold = (await cardd.board()).holds.find((each) => each.card === card.id);
    assert.ok(hold);
    h.onModel(() => ({ text: "The board answer is recorded." }), "mate");
    assert.equal(await cardd.act(card.id, { kind: "answer", hold: hold.hold, choice: "Yes" }), 200);
    originalPane(await screenWith(lab, pane, "The board answer is recorded."));
    assert.equal(
      (await cardd.post(token, "hold", { card: card.id, question: "Ship it?", options: ["Yes"] }))
        .status,
      200,
    );
    const words = "Yes, ship the short name";
    h.onModel(() => ({ tool: "hold", args: { card: card.id, clear: true, words } }), "mate");
    h.onModel(() => ({ text: "Your chat answer is recorded." }), "mate");
    await lab.submit(pane, words);
    const answered = await screenWith(lab, pane, "Your chat answer is recorded.");
    originalPane(answered);
    keep("3-chat-answer", answered);
    assert.equal(
      (await cardd.thread(card.id)).entries.findLast((entry) => entry.kind === "answer")?.body,
      words,
    );
    assert.equal((await cardd.board()).holds.length, 0);
    h.onModel(() => ({ text: "No neglect overlay is registered." }), "mate");
    await lab.submit(pane, "/pulse");
    originalPane(await screenWith(lab, pane, "No neglect overlay is registered."));
    await lab.submit(pane, "/probe-reload");
    await h.waitFor(
      (event) => event["type"] === "session" && event["reason"] === "reload",
      "reload",
    );
    const reloaded = await screenWith(lab, pane, base);
    originalPane(reloaded);
    keep("4-reloaded", reloaded);
  } finally {
    await lab.printIfFailed(context);
    await Promise.allSettled([main.close(), lab.stop(), h.stop(), cardd.stop()]);
    scratch.dispose();
  }
});
