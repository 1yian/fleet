import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CardSchema, check } from "@fleet/protocol";
import { startFleet } from "../support/fleet.ts";
import { spawnGuarded } from "../support/guarded.ts";
import { Harness, Pi } from "../support/harness.ts";
import { isRecord, records } from "../support/json.ts";
import { Scratch } from "../support/scratch.ts";

const PI = fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url));

test("a mate home discovers the walkthrough command and keeps a partially answered gate on the live board", async () => {
  const scratch = new Scratch();
  const fleet = await startFleet();
  const h = await Harness.start();
  let pi: Pi | undefined;
  try {
    const card = check(
      CardSchema,
      await fleet.main.call("card.new", { title: "Release choices", kind: "captain" }),
    );
    await fleet.main.call("hold", {
      card: card.id,
      question: "1. Use the short release name? 2. Start in the EU?",
      options: ["Both", "Discuss"],
    });
    h.onModel(() => ({ tool: "board", args: { card: card.id } }));
    h.onModel((turns) => {
      assert.match(turns.at(-1)?.text ?? "", /Use the short release name/);
      return {
        tool: "hold",
        args: {
          card: card.id,
          question: 'Question 1 answered: "Use the short name." Remaining: 2. Start in the EU?',
          options: ["EU", "US"],
        },
      };
    });
    h.onModel(() => ({ text: "Captain, the name is recorded. Start in the EU?" }));
    const args = h
      .piArgs()
      .filter((arg) => !["--no-skills", "--no-prompt-templates", "--no-approve"].includes(arg));
    const child = spawnGuarded(
      PI,
      [
        "--mode",
        "rpc",
        "--approve",
        ...args,
        "-e",
        join(scratch.root, "e2e/support/probe.ts"),
        "-e",
        join(scratch.root, "packages/extension/src/index.ts"),
      ],
      {
        cwd: scratch.root,
        stdio: ["pipe", "pipe", "inherit"],
        env: {
          ...process.env,
          ...h.piEnv("default"),
          FLEET_URL: fleet.cardd.url,
          FLEET_TOKEN: fleet.mainToken,
          FLEET_ROLE: "mate",
        },
      },
    );
    pi = new Pi(child);
    child.stdin?.write(`${JSON.stringify({ type: "get_commands" })}\n`);
    await h.waitFor((event) => event["type"] === "fleet_connected", "the mate to connect");
    pi.prompt("/decisions Use the short name.");
    await h.waitFor((event) => event["type"] === "settled", "walkthrough turn");
    const commands = pi.responses.find((response) => response["command"] === "get_commands");
    const data = commands?.["data"];
    if (!isRecord(data)) throw new Error("get_commands returned no data");
    const found = records(data["commands"]).find(
      (command) => command["name"] === "skill:decision-walkthrough",
    );
    assert.equal(found?.["source"], "skill");
    assert.equal(
      records(data["commands"]).find((command) => command["name"] === "decisions")?.["source"],
      "prompt",
    );
    assert.deepEqual(
      (await fleet.cardd.board()).holds.map((hold) => [hold.card, hold.question, hold.options]),
      [
        [
          card.id,
          'Question 1 answered: "Use the short name." Remaining: 2. Start in the EU?',
          ["EU", "US"],
        ],
      ],
    );
  } finally {
    await pi?.kill();
    await h.stop();
    await fleet.cardd.stop();
    scratch.dispose();
  }
});
