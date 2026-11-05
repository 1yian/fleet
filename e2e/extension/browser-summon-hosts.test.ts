import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BrowserHerdr, until } from "../support/browser-herdr.ts";
import { relayPorts, transportLog } from "../support/browser-hosts.ts";
import { parseRecord } from "../support/json.ts";

let fleet: BrowserHerdr;

afterEach(async (t) => {
  await fleet.stop(t);
});

const BROWSER = "Browser";
const HOSTS = { names: ["alpha", "beta"], mainHost: "alpha" };

const relayedFor = (who: string, host: string): number[] =>
  relayPorts(transportLog(fleet.dir, who, host));

test("the captain is summoned to a worker on another host: main's workspace shows that host's Chrome over main's transport", async () => {
  fleet = await BrowserHerdr.start({ browser: true, hosts: HOSTS });
  const [worker] = await fleet.workers(["Pay the invoice"], "beta");
  assert.ok(worker !== undefined);
  fleet.h.onModel(() => ({ text: "told the captain" }), "mate");
  await fleet.startMain();
  const main = await fleet.mainWorkspace();
  const beta = fleet.chromes.get("beta");
  const alpha = fleet.chromes.get("alpha");
  assert.ok(beta !== undefined && alpha !== undefined);

  const opened = await fleet.axi(
    worker,
    `open ${fleet.site.url("/a")} --captain 'the bank asks for a passkey'`,
  );

  assert.equal(opened.code, 0, opened.text);
  assert.match(String(parseRecord(opened.text.split("\n")[0] ?? "")["view"]), /main's workspace/);
  assert.equal((await beta.pages()).length, 1);
  assert.deepEqual(await alpha.pages(), []);
  await until("the Browser tab in main's workspace", async () =>
    (await fleet.tabLabels(main)).includes(BROWSER) ? true : undefined,
  );
  assert.equal((await fleet.tabLabels(worker.workspace)).includes(BROWSER), false);
  const address = await fleet.viewerOf(main);
  const seen = await fleet.tabsSeenBy(address);
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? "", new RegExp(`^c-${String(worker.card.id)} pay-the-invoice`));
  const target = (await beta.pages())[0]?.id;
  assert.ok(target !== undefined);

  const picture = await fleet.pictureOf(address, target);

  assert.ok(picture.width > 0 && picture.bytes > 0);
  assert.ok(
    relayedFor("main", "beta").includes(beta.port),
    "the picture came over main's route to beta",
  );
  assert.equal(relayedFor("main", "beta").includes(alpha.port), false);
  assert.deepEqual(relayedFor("main", "alpha"), [], "main's own host needs no route");
  const heard = await fleet.h.waitForCall(0, "mate");
  assert.match(
    heard.map((turn) => turn.text).join("\n"),
    /needs the captain in its browser tab: the bank asks for a passkey/,
  );
});

test("a lane's worker summons the captain: the lane's workspace when he is in it, otherwise main's, from the lane's host", async () => {
  fleet = await BrowserHerdr.start({ browser: true, hosts: HOSTS });
  await fleet.workers([], "beta");
  fleet.h.onModel(() => ({ text: "told the captain" }), "mate");
  fleet.h.onModel(() => ({ text: "told the captain too" }), "cnp");
  await fleet.startMain();
  const main = await fleet.mainWorkspace();
  const mate = await fleet.startMate("cnp", "Pay the vendor", "beta");
  const beta = fleet.chromes.get("beta");
  assert.ok(beta !== undefined);
  await fleet.focus(main);

  const away = await fleet.axi(
    mate.worker,
    `open ${fleet.site.url("/a")} --captain 'the vendor wants a passkey'`,
  );

  assert.equal(away.code, 0, away.text);
  await until("the Browser tab in main's workspace", async () =>
    (await fleet.tabLabels(main)).includes(BROWSER) ? true : undefined,
  );
  assert.equal((await fleet.tabLabels(mate.workspace)).includes(BROWSER), false);
  const target = (await beta.pages())[0]?.id;
  assert.ok(target !== undefined);
  const mainView = await fleet.viewerOf(main);
  assert.ok((await fleet.pictureOf(mainView, target)).bytes > 0);
  assert.ok(relayedFor("main", "beta").includes(beta.port));
  const heard = await fleet.h.waitForCall(0, "mate");
  assert.match(heard.map((turn) => turn.text).join("\n"), /cnp/);

  await fleet.focus(mate.workspace);
  const here = await fleet.axi(mate.worker, `read --captain 'now the vendor wants a code'`);
  assert.equal(here.code, 0, here.text);
  await until("the Browser tab in the lane's workspace", async () =>
    (await fleet.tabLabels(mate.workspace)).includes(BROWSER) ? true : undefined,
  );
  const laneView = await fleet.viewerOf(mate.workspace);
  assert.ok((await fleet.pictureOf(laneView, target)).bytes > 0);
  assert.deepEqual(relayedFor("cnp", "beta"), [], "the lane's own host needs no route");
  assert.deepEqual(relayedFor("cnp", "alpha"), []);
});
