import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { BrowserHerdr, until } from "../support/browser-herdr.ts";
import { lanAddress } from "../support/tailnet.ts";

let fleet: BrowserHerdr;

afterEach(async (t) => {
  await fleet.stop(t);
});

const address = lanAddress();
const NO_ADDRESS = address === undefined ? "this machine has no non-loopback IPv4 address" : false;
const LINK = /http:\/\/[^\s]+\/\?t=[\w-]+/;
const CAPTAIN_LINE = /Fleet browser viewer \(captain\)/g;

const heardAbout = (why: RegExp): Promise<string> =>
  until(`main to hear ${String(why)}`, () =>
    fleet.h
      .callsOf("mate")
      .flatMap((turns) => turns.filter((turn) => turn.role === "user").map((turn) => turn.text))
      .find((text) => why.test(text)),
  );

function everythingCarddKeeps(): string {
  const db = new DatabaseSync(fleet.cardd.db, { readOnly: true });
  try {
    return JSON.stringify(db.prepare("SELECT * FROM entries").all());
  } finally {
    db.close();
  }
}

test(
  "the mate that is summoned gets the captain's link in its own message, and the link is kept nowhere else",
  { skip: NO_ADDRESS },
  async () => {
    assert.ok(address !== undefined);
    fleet = await BrowserHerdr.start({ browser: true, tailnet: address });
    const [worker] = await fleet.workers(["Sign in to Google"]);
    assert.ok(worker !== undefined);
    fleet.h.onModel(() => ({ text: "sent the captain his link" }), "mate");
    await fleet.startMain();

    const opened = await fleet.axi(
      worker,
      `open ${fleet.site.url("/a")} --captain 'Google asks for a second factor'`,
    );
    assert.equal(opened.code, 0, opened.text);

    const heard = await heardAbout(/needs the captain in its browser tab: Google asks/);
    const link = LINK.exec(heard)?.[0];
    assert.ok(link !== undefined, "the summon carries the captain's link");
    const shown = new URL(link);
    assert.equal(shown.hostname, address);
    assert.ok(!shown.hostname.startsWith("127."), "a phone cannot open a loopback address");
    assert.equal((await fetch(link, { redirect: "manual" })).status, 200);
    assert.match(heard, /opens on his phone or his Mac over Tailscale/);
    assert.match(heard, /never write it on the board, in a card, in a report, or in a log/);

    const token = shown.searchParams.get("t") ?? "";
    assert.ok(token.length >= 32);
    assert.equal(everythingCarddKeeps().includes(token), false, "cardd keeps no copy of the token");
    assert.equal(opened.text.includes(token), false, "the worker never sees the token");
  },
);

test("with no tailnet address the mate is told that the captain's phone cannot open the viewer", async () => {
  fleet = await BrowserHerdr.start({ browser: true });
  const [worker] = await fleet.workers(["Sign in to Google"]);
  assert.ok(worker !== undefined);
  fleet.h.onModel(() => ({ text: "told the captain" }), "mate");
  await fleet.startMain();

  const opened = await fleet.axi(
    worker,
    `open ${fleet.site.url("/a")} --captain 'Google asks for a second factor'`,
  );
  assert.equal(opened.code, 0, opened.text);

  const heard = await heardAbout(/needs the captain in its browser tab: Google asks/);
  assert.match(heard, /listens on this machine only, because no Tailscale address was found/);
  assert.match(heard, /so his phone or another machine cannot open it/);
  assert.equal(new URL(LINK.exec(heard)?.[0] ?? "").hostname, "127.0.0.1");
});

test(
  "a captain's viewer that an update left running is replaced, and the next summon carries the new link",
  { skip: NO_ADDRESS },
  async () => {
    assert.ok(address !== undefined);
    fleet = await BrowserHerdr.start({ browser: true, tailnet: address });
    const [worker] = await fleet.workers(["Sign in to Google"]);
    assert.ok(worker !== undefined);
    fleet.h.onModel(() => ({ text: "sent the captain his link" }), "mate");
    await fleet.startMain();
    const main = await fleet.mainWorkspace();
    const stale = "http://127.0.0.1:9/?t=staletokenstaletokenstaletokenstale";
    const pane = await fleet.browserTab(main);
    await fleet.lab.submit(pane, `printf 'Fleet browser viewer (captain): ${stale}\\n'; sleep 600`);
    await until("the old viewer to be running", async () =>
      (await fleet.history(pane)).includes(stale) ? true : undefined,
    );

    const opened = await fleet.axi(
      worker,
      `open ${fleet.site.url("/a")} --captain 'Google asks for a second factor'`,
    );
    assert.equal(opened.code, 0, opened.text);

    const heard = await heardAbout(/needs the captain in its browser tab: Google asks/);
    const link = LINK.exec(heard)?.[0];
    assert.ok(link !== undefined && link !== stale, "the link is the new viewer's");
    assert.equal(new URL(link).hostname, address, "the new viewer is on the tailnet address");
    assert.equal((await fleet.listingOf(link)).tabs.length, 1);
    assert.match(await fleet.history(pane), /Viewer build: \w+/);
  },
);

test(
  "a captain's viewer that was stopped and is summoned again carries its new link, not the old one in the pane",
  { skip: NO_ADDRESS },
  async () => {
    assert.ok(address !== undefined);
    fleet = await BrowserHerdr.start({ browser: true, tailnet: address });
    const [first, second] = await fleet.workers(["Sign in to Google", "Pay the invoice"]);
    assert.ok(first !== undefined && second !== undefined);
    fleet.h.onModel(() => ({ text: "sent the captain his link" }), "mate");
    await fleet.startMain();
    const main = await fleet.mainWorkspace();
    await fleet.axi(
      first,
      `open ${fleet.site.url("/a")} --captain 'Google asks for a second factor'`,
    );
    const oldLink = LINK.exec(await heardAbout(/Google asks for a second factor/))?.[0];
    assert.ok(oldLink !== undefined);
    const pane = await fleet.viewerPane(main);
    await fleet.lab.press(pane, "ctrl+c");
    await until("the old viewer to stop answering", async () =>
      (await fetch(oldLink).then(
        () => false,
        () => true,
      ))
        ? true
        : undefined,
    );
    assert.ok((await fleet.history(pane)).includes(oldLink), "the old link is still in the pane");

    await fleet.axi(second, `open ${fleet.site.url("/b")} --captain 'the bank asks for a code'`);

    const newLink = LINK.exec(await heardAbout(/the bank asks for a code/))?.[0];
    assert.ok(newLink !== undefined && newLink !== oldLink, "the link is the new viewer's");
    assert.equal((await fetch(newLink, { redirect: "manual" })).status, 200);
  },
);

test(
  "a captain's viewer that is current is reused, and a second summon carries the same link",
  { skip: NO_ADDRESS },
  async () => {
    assert.ok(address !== undefined);
    fleet = await BrowserHerdr.start({ browser: true, tailnet: address });
    const [first, second] = await fleet.workers(["Sign in to Google", "Pay the invoice"]);
    assert.ok(first !== undefined && second !== undefined);
    fleet.h.onModel(() => ({ text: "sent the captain his link" }), "mate");
    await fleet.startMain();
    const main = await fleet.mainWorkspace();
    await fleet.axi(
      first,
      `open ${fleet.site.url("/a")} --captain 'Google asks for a second factor'`,
    );
    const firstLink = LINK.exec(await heardAbout(/Google asks for a second factor/))?.[0];
    assert.ok(firstLink !== undefined);

    await fleet.axi(second, `open ${fleet.site.url("/b")} --captain 'the bank asks for a code'`);

    const secondLink = LINK.exec(await heardAbout(/the bank asks for a code/))?.[0];
    assert.equal(secondLink, firstLink);
    const printed = (await fleet.history(await fleet.viewerPane(main))).match(CAPTAIN_LINE);
    assert.equal(printed?.length, 1, "the viewer was started once");
  },
);
