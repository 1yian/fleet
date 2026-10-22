import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, test } from "node:test";
import { Cardd } from "./cardd.ts";
import { Harness } from "./harness.ts";
import { Scratch } from "./scratch.ts";

const MODE = process.env["LEAK_MODE"] ?? "pass";
const REPORT_PORT = Number(process.env["LEAK_REPORT_PORT"]);

let cardd: Cardd | undefined;
let h: Harness | undefined;
let scratch: Scratch | undefined;

after(async () => {
  scratch?.dispose();
  await Promise.allSettled([h?.stop(), cardd?.stop()]);
});

test("a scratch fleet with cardd, fake GitHub, and a Pi", async () => {
  scratch = new Scratch();
  cardd = await Cardd.start();
  h = await Harness.start();
  h.startPi("leak");
  await h.waitFor((event) => event["type"] === "session", "the Pi to start");
  if (MODE === "pass") return;
  if (MODE === "fail") assert.fail("the scenario fails on purpose");
  const socket = connect(REPORT_PORT, "127.0.0.1");
  socket.write(`${String(process.pid)}\n`);
  await new Promise(() => undefined);
});
