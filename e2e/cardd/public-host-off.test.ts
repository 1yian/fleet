import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { Cardd } from "../support/cardd.ts";
import { exchange, PUBLIC_HOST, upgrade } from "../support/public-host.ts";

const BOARD = fileURLToPath(new URL("../../packages/board/dist", import.meta.url));
const ORIGIN = `https://${PUBLIC_HOST}`;
const TOKEN = "never.checked.token";
const JSON_BODY = { "content-type": "application/json" };

let cardd: Cardd;
beforeEach(async () => {
  cardd = await Cardd.start({}, ["--board", BOARD]);
});
afterEach(async () => {
  await cardd.stop();
});

const base = (): URL => new URL(cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/"));

test("without the four public-host values, cardd refuses the public host and its https origin as it always did", async () => {
  const own = base().host;
  const named = { host: PUBLIC_HOST, origin: ORIGIN, "cf-access-jwt-assertion": TOKEN };

  const board = await exchange(base(), "/api/board", "GET", named);
  assert.equal(board.status, 403);
  assert.match(board.body, /only to these hosts: .*127\.0\.0\.1:\d+/);
  assert.equal((await exchange(base(), "/", "GET", named)).status, 403);
  const action = await exchange(base(), "/api/action", "POST", { ...JSON_BODY, ...named }, {});
  assert.equal(action.status, 403);
  assert.equal(await upgrade(base(), "/live", named), "refused");

  const rebound = { host: own, origin: ORIGIN };
  assert.equal((await exchange(base(), "/api/board", "GET", rebound)).status, 403);
  assert.equal(await upgrade(base(), "/live", rebound), "refused");

  const forwarded = { host: own, "cf-ray": "8a1b2c3d4e5f-AMS", "cf-access-jwt-assertion": TOKEN };
  assert.equal((await exchange(base(), "/api/board", "GET", forwarded)).status, 200);
  assert.equal(await upgrade(base(), "/live", forwarded), "opened");
});
