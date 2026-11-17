import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { quote } from "@fleet/protocol/route";
import { begin, newCard, startFleet } from "../support/fleet.ts";
import { tempDir } from "../support/run-root.ts";

const WRAPPER = fileURLToPath(new URL("../../packages/extension/src/job.ts", import.meta.url));

const cases = [
  { label: "one", command: "exit 1", code: 1 },
  { label: "seven", command: "exit 7", code: 7 },
  { label: "success", command: "printf success", code: 0 },
  { label: "tail", command: "node --test SUITE | tail -n 5", code: 1 },
  { label: "tee", command: "node --test SUITE | tee LOG", code: 1 },
  { label: "trailing", command: "false; printf finished", code: 0 },
  { label: "chained", command: "false && printf finished", code: 1 },
  { label: "recovery", command: "false || printf recovered", code: 0 },
  { label: "conditional", command: "if false; then exit 9; else printf handled; fi", code: 0 },
  { label: "signal", command: "kill -TERM $$", code: 143 },
  { label: "missing", command: "fleet_nonexistent_command", code: 127 },
  { label: "spawn-error", command: "true", code: 127 },
  {
    label: "cancel",
    command: `node -e 'require("net").createServer().listen(0, "127.0.0.1", () => console.log("ready"))'`,
    code: 130,
  },
  {
    label: "timeout",
    command: `node -e 'require("net").createServer().listen(0, "127.0.0.1")'`,
    code: 124,
  },
];

for (const scenario of cases) {
  test(`the wrapper process and durable result agree: ${scenario.label}`, async () => {
    const fleet = await startFleet();
    const dir = tempDir("fleet-job-exit-");
    const card = await newCard(fleet.main, "Truthful command status");
    const token = await begin(fleet.main, card);
    const worker = await fleet.cardd.connect(token, [], false);
    const suite = join(dir, "failure.test.mjs");
    writeFileSync(
      suite,
      'import { test } from "node:test"; test("failure", () => { throw Error("suite failed"); });',
    );
    const command = scenario.command
      .replace("SUITE", quote(suite))
      .replace("LOG", quote(join(dir, "log")));
    const { job, heartbeatMs } = check(
      OPS["job.start"].result,
      await worker.call("job.start", { label: scenario.label, command }),
    );
    const file = join(dir, "job.json");
    writeFileSync(
      file,
      JSON.stringify({
        url: fleet.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/call"),
        token,
        job,
        command,
        heartbeatMs,
        timeoutMs: scenario.label === "timeout" ? 100 : 10_000,
      }),
    );
    const env = { ...process.env };
    delete env["HERDR_TAB_ID"];
    delete env["NODE_TEST_CONTEXT"];
    if (scenario.label === "spawn-error") env["PATH"] = dir;
    const child = spawn(process.execPath, [WRAPPER, file], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let output = "";
    let cancelled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (scenario.label === "cancel" && !cancelled && output.includes("ready")) {
        cancelled = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    try {
      await closed;
      const code = child.exitCode;
      const signal = child.signalCode;
      const entry = await worker.waitForEntry(
        (each) => each.kind === "job-result",
        "the durable result",
      );
      console.log(
        JSON.stringify({ label: scenario.label, code, signal, fields: entry.fields, output }),
      );
      assert.equal(code, scenario.code, output);
      assert.equal(signal, null);
      assert.equal(entry.fields["exitCode"], scenario.code);
      assert.match(output, new RegExp(`exited ${String(scenario.code)}`));
      if (scenario.label === "trailing") assert.match(output, /WARNING.*last command/);
      await worker.close();
      const recovered = await fleet.cardd.connect(token, [], false);
      const replay = await recovered.waitForEntry(
        (each) => each.id === entry.id,
        "the persisted result after reconnect",
      );
      assert.equal(replay.fields["exitCode"], scenario.code);
      await recovered.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await closed;
      }
      await fleet.cardd.stop();
    }
  });
}
