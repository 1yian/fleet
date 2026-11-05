import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { check, OPS } from "@fleet/protocol";
import { HostLab, relayPorts } from "../support/browser-hosts.ts";
import { FakeVault } from "../support/fake-vault.ts";
import {
  FIELD,
  GOOD,
  OTHER,
  OTHER_PASSWORD,
  OTHER_USER,
  PASSWORD,
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
