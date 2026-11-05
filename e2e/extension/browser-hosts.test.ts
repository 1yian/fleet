import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { HostLab, relayPorts } from "../support/browser-hosts.ts";
import { FakeVault } from "../support/fake-vault.ts";
import { newCard } from "../support/fleet.ts";
import {
  FIELD,
  GOOD,
  OTHER,
  OTHER_PASSWORD,
  OTHER_USER,
  PASSWORD,
  until,
  USERNAME,
} from "../support/login-fixtures.ts";

let lab: HostLab;
const vaults: FakeVault[] = [];

afterEach(async () => {
  await lab.stop();
  for (const vault of vaults.splice(0)) vault.dispose();
});

test("each crew drives the Chrome of its own host and no other, and closing one leaves the other", async () => {
  lab = await HostLab.start([{ name: "alpha" }, { name: "beta" }]);
  const a = await lab.worker("Users see one scrollbar", "alpha");
  const b = await lab.worker("Users see one footer", "beta");

  await a.act({ action: "open", url: lab.site.url("/a") });
  await b.act({ action: "open", url: lab.site.url("/b") });

  assert.deepEqual(await lab.pathsOn("alpha"), ["/a"]);
  assert.deepEqual(await lab.pathsOn("beta"), ["/b"]);
  assert.deepEqual(await lab.tabHosts(), [
    `${String(a.card.id)}@alpha`,
    `${String(b.card.id)}@beta`,
  ]);
  assert.match(await a.act({ action: "read" }), /alpha page/);
  assert.match(await b.act({ action: "read" }), /bravo page/);
  for (const host of ["alpha", "beta"])
    assert.deepEqual(
      new Set(relayPorts(lab.commands("cardd", host))),
      new Set([lab.chrome(host).port]),
      `${host}'s transport carried only ${host}'s Chrome`,
    );

  await a.act({ action: "close" });
  assert.deepEqual(await lab.pathsOn("alpha"), []);
  assert.deepEqual(await lab.pathsOn("beta"), ["/b"]);
  const released = check(
    OPS["browser.release"].result,
    await lab.main.call("browser.release", { card: b.card.id }),
  );
  assert.equal(released.closed, 1);
  assert.deepEqual(await lab.pathsOn("beta"), []);
});

test("a card on a host with no browser configured is told so, and no other host's Chrome is used", async () => {
  lab = await HostLab.start([{ name: "alpha" }, { name: "gamma", browser: false }]);
  const g = await lab.worker("Look at the site", "gamma");

  const opened = await g.run(["open", lab.site.url("/a")]);
  const status = await g.run([]);

  for (const run of [opened, status]) {
    assert.equal(run.code, 4, JSON.stringify(run.record));
    assert.match(String(run.record["error"]), /no shared browser configured on host gamma/);
    assert.match(String(run.record["error"]), /names alpha/);
  }
  assert.deepEqual(await lab.pathsOn("alpha"), []);
});

test("a host that --browser names but cardd has no route to says so, and the other hosts are unaffected", async () => {
  lab = await HostLab.start([{ name: "alpha" }, { name: "delta", route: false }]);
  const d = await lab.worker("Look at the site", "delta");
  const a = await lab.worker("Users see one scrollbar", "alpha");

  const opened = await d.run(["open", lab.site.url("/a")]);

  assert.equal(opened.code, 1, JSON.stringify(opened.record));
  assert.match(String(opened.record["error"]), /the browser on delta cannot be reached/);
  assert.match(String(opened.record["error"]), /--hosts/);
  await a.act({ action: "open", url: lab.site.url("/a") });
  assert.deepEqual(await lab.pathsOn("alpha"), ["/a"]);
});

test("a host whose Chrome is down fails alone: the other host keeps working", async () => {
  lab = await HostLab.start([{ name: "alpha" }, { name: "beta" }]);
  const a = await lab.worker("Users see one scrollbar", "alpha");
  const b = await lab.worker("Users see one footer", "beta");
  await a.act({ action: "open", url: lab.site.url("/a") });
  await b.act({ action: "open", url: lab.site.url("/b") });

  await lab.chrome("alpha").stop();

  await assert.rejects(
    a.act({ action: "open", url: lab.site.url("/a") }),
    /the browser on alpha is unreachable/,
  );
  assert.match(await b.act({ action: "read" }), /bravo page/);
});

test("each host reads only its own vault: a login never uses another host's entry or token", async () => {
  const personal = new FakeVault([GOOD]);
  const cnp = new FakeVault([OTHER], {
    token: "0.fake-cnp-machine-account-token.not-a-real-token",
    project: "6c1f5a43-0b6e-4c53-9d58-2f0d6a1f7e22",
  });
  vaults.push(personal, cnp);
  lab = await HostLab.start([
    { name: "alpha", vault: personal },
    { name: "beta", vault: cnp },
  ]);
  const a = await lab.worker("Sign in to the portal", "alpha");
  const b = await lab.worker("Sign in to the vendor", "beta");
  const example = lab.site.url("/login", "login.example.test");
  const nothing = lab.site.url("/login", "login.nothing.test");

  await a.act({ action: "open", url: example });
  assert.match(await a.act({ action: "login" }), /^filled: Filled the username and password\./);
  await b.act({ action: "open", url: example });
  const missing = await b.run(["login"]);
  assert.equal(missing.code, 3, JSON.stringify(missing.record));
  assert.match(
    String(missing.record["result"]),
    /^not found: the Logins project has no entry for login\.example\.test/,
  );
  assert.equal(await b.act({ action: "eval", expression: `${FIELD("p")}.value` }), '""');

  await b.act({ action: "open", url: nothing });
  assert.match(await b.act({ action: "login" }), /^filled: Filled the username and password\./);
  await a.act({ action: "open", url: nothing });
  assert.equal((await a.run(["login"])).code, 3);

  assert.ok(personal.invocations().length > 0 && cnp.invocations().length > 0);
  for (const call of personal.invocations()) assert.ok(call.includes(personal.identity.project));
  for (const call of cnp.invocations()) assert.ok(call.includes(cnp.identity.project));
  const onAlpha = lab.commands("cardd", "alpha").join("\n");
  const onBeta = lab.commands("cardd", "beta").join("\n");
  assert.ok(onAlpha.includes(personal.tokenFile) && !onAlpha.includes(cnp.tokenFile));
  assert.ok(onBeta.includes(cnp.tokenFile) && !onBeta.includes(personal.tokenFile));
  const everything = `${onAlpha}\n${onBeta}`;
  for (const secret of [
    PASSWORD,
    USERNAME,
    OTHER_USER,
    OTHER_PASSWORD,
    personal.identity.token,
    cnp.identity.token,
  ])
    assert.equal(everything.includes(secret), false, "a secret reached a host's transport");
});

test("a login request belongs to one host's vault: a card that moves to another host is asked for again, naming that host", async () => {
  const alphaVault = new FakeVault([]);
  const betaVault = new FakeVault([], {
    token: "0.fake-cnp-machine-account-token.not-a-real-token",
    project: "6c1f5a43-0b6e-4c53-9d58-2f0d6a1f7e22",
  });
  vaults.push(alphaVault, betaVault);
  lab = await HostLab.start([
    { name: "alpha", vault: alphaVault },
    { name: "beta", vault: betaVault },
  ]);
  const cnp = await lab.lane("cnp");
  const card = await newCard(cnp, "Sign in to the vendor");
  const page = lab.site.url("/login", "login.example.test");
  const drive = async (host: string, args: Record<string, unknown>) =>
    check(OPS.browser.result, await lab.main.call("browser", { card: card.id, host, ...args }));

  await drive("alpha", { action: "open", url: page });
  const onAlpha = await drive("alpha", { action: "login" });
  await drive("beta", { action: "open", url: page });
  const onBeta = await drive("beta", { action: "login" });
  const again = await drive("beta", { action: "login" });
  await cnp.waitForEntry(
    (entry) => entry.fields["summon"] === "a missing login entry for login.example.test on beta",
    "the summon for the login that beta's vault lacks",
  );

  assert.match(onAlpha.text, /I asked your mate to have one added/);
  assert.match(onBeta.text, /I asked your mate to have one added/);
  assert.match(again.text, /your mate was already asked/);
  const filed = cnp.entries.map(({ entry }) => entry).filter((entry) => entry.author === "browser");
  const requests = filed.filter((entry) => entry.fields["loginFor"] !== undefined);
  assert.equal(requests.length, 2);
  assert.match(requests[0]?.body ?? "", /Logins project that alpha reads/);
  assert.match(requests[1]?.body ?? "", /Logins project that beta reads/);
  assert.deepEqual(
    filed.map((entry) => entry.fields["summon"]).filter((why) => why !== undefined),
    [
      "a missing login entry for login.example.test on alpha",
      "a missing login entry for login.example.test on beta",
    ],
  );
});

test("a host that hangs while connecting is reported unavailable, and the other hosts are still listed", async () => {
  lab = await HostLab.start([{ name: "alpha" }, { name: "beta", hangs: true }]);
  const a = await lab.worker("Users see one scrollbar", "alpha");
  await a.act({ action: "open", url: lab.site.url("/a") });

  const began = Date.now();
  const view = check(
    OPS["browser.view"].result,
    await lab.main.call("browser.view", { host: "beta" }),
  );

  assert.ok(Date.now() - began < 8_000, "the listing did not wait for the hung host");
  assert.deepEqual(
    view.tabs.map((tab) => [tab.card, tab.host, tab.live]),
    [[a.card.id, "alpha", true]],
  );
  assert.match(view.problem ?? "", /^the browser on beta is unavailable: it did not answer within/);
  assert.deepEqual(
    view.browsers.map((browser) => browser.host),
    ["alpha", "beta"],
  );
});

test("a card that moves to another host retires its tab on a host that is no longer configured, and that old tab is closed when the host is configured again", async () => {
  lab = await HostLab.start([{ name: "alpha" }, { name: "beta" }]);
  const card = await newCard(lab.main, "Look at the site");
  const drive = async (host: string, args: Record<string, unknown>) =>
    check(OPS.browser.result, await lab.main.call("browser", { card: card.id, host, ...args }));
  await drive("alpha", { action: "open", url: lab.site.url("/a") });

  await lab.rebrowse(["beta"]);
  await drive("beta", { action: "open", url: lab.site.url("/b") });
  const seen = await drive("beta", { action: "read" });

  assert.match(seen.text, /bravo page/);
  assert.deepEqual(await lab.tabHosts(), [`${String(card.id)}@beta`]);
  assert.deepEqual(
    await lab.pathsOn("alpha"),
    ["/a"],
    "alpha's Chrome cannot be reached from here",
  );

  await lab.rebrowse(["alpha", "beta"]);
  await lab.tabHosts();
  await until(
    async () => ((await lab.pathsOn("alpha")).length === 0 ? true : undefined),
    "the retired tab on alpha to be closed",
  );
  assert.deepEqual(await lab.pathsOn("beta"), ["/b"]);
  assert.match((await drive("beta", { action: "read" })).text, /bravo page/);
});

test("a release that cannot record the retirement fails, on a configured host and on one that is no longer configured", async () => {
  lab = await HostLab.start([{ name: "alpha" }, { name: "beta" }]);
  const card = await newCard(lab.main, "Look at the site");
  await lab.main.call("browser", {
    card: card.id,
    host: "alpha",
    action: "open",
    url: lab.site.url("/a"),
  });
  lab.cardd.refuseBrowserTabRetirement();

  await assert.rejects(
    lab.main.call("browser.release", { card: card.id }),
    /browser_tabs refuses the retirement/,
  );
  assert.deepEqual(await lab.tabHosts(), [`${String(card.id)}@alpha`]);

  await lab.rebrowse(["beta"]);
  await assert.rejects(
    lab.main.call("browser.release", { card: card.id }),
    /browser_tabs refuses the retirement/,
  );
  await assert.rejects(
    lab.main.call("browser", {
      card: card.id,
      host: "beta",
      action: "open",
      url: lab.site.url("/b"),
    }),
    /browser_tabs refuses the retirement/,
  );
  assert.deepEqual(await lab.pathsOn("beta"), []);
});

test("a viewer follows a host whose Chrome endpoint changed: its picture comes from the new Chrome", async () => {
  lab = await HostLab.start([{ name: "alpha" }]);
  const card = await newCard(lab.main, "Look at the site");
  const open = async (path: string) =>
    lab.main.call("browser", {
      card: card.id,
      host: "alpha",
      action: "open",
      url: lab.site.url(path),
    });
  await open("/a");
  const address = await lab.viewer("alpha");
  const [before] = await lab.viewerTargets(address);
  assert.ok(before !== undefined);
  assert.ok((await lab.viewerPicture(address, before)) > 0);

  await lab.moveBrowser("alpha");
  await open("/b");

  const targets = await lab.viewerTargets(address);
  assert.equal(targets.length, 1);
  const [after] = targets;
  assert.ok(after !== undefined && after !== before);
  assert.deepEqual(await lab.pathsOn("alpha"), ["/b"]);
  assert.ok((await lab.viewerPicture(address, after)) > 0);
});
