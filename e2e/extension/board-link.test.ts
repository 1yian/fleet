import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { begin, newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { Harness } from "../support/harness.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));
const ESC = "\u001b";
const OSC8 = `${ESC}]8;;`;
const ST = `${ESC}\\`;
const SGR = new RegExp(`${ESC}\\[[\\d;]*m`, "g");

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

const boardUrl = (): string => fleet.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/");

const isBoardStatus = (event: Record<string, unknown>): boolean =>
  event["method"] === "setStatus" && event["statusKey"] === "fleet-board";

test("main's status line shows the word board as a link to the board, without the URL or the token", async () => {
  const pi = h.startPi(
    "main",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: fleet.mainToken,
      FLEET_ROLE: "mate",
      PI_HYPERLINKS: "1",
    },
    [EXTENSION],
  );
  const status = await pi.waitForUi(isBoardStatus, "the board link in the status line");
  const text = String(status["statusText"]);
  assert.equal(text.replace(SGR, ""), `${OSC8}${boardUrl()}${ST}board${OSC8}${ST}`);
  assert.equal(text.split(boardUrl()).length, 2, "the URL is only the link's target");
  assert.ok(!JSON.stringify(status).includes(fleet.mainToken));
});

test("a terminal without hyperlinks shows the word board and no URL", async () => {
  const pi = h.startPi(
    "main",
    {
      FLEET_URL: fleet.cardd.url,
      FLEET_TOKEN: fleet.mainToken,
      FLEET_ROLE: "mate",
      PI_HYPERLINKS: "0",
    },
    [EXTENSION],
  );
  const status = await pi.waitForUi(isBoardStatus, "the word board in the status line");
  assert.equal(String(status["statusText"]).replace(SGR, ""), "board");
});

test("a worker's status line has no board link", async () => {
  const card = await newCard(fleet.main, "Fix the thing");
  const token = await begin(fleet.main, card, "Fix the thing");
  const pi = h.startPi(
    "worker",
    { FLEET_URL: fleet.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker", PI_HYPERLINKS: "1" },
    [EXTENSION],
  );
  await h.waitFor((e) => e["type"] === "fleet_connected", "the worker to connect");
  assert.equal(pi.uiRequests.filter(isBoardStatus).length, 0);
});
