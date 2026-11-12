import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AttachLab, type Run } from "../support/attach-lab.ts";
import { StandInChrome } from "../support/chrome.ts";
import { GuardLab, until } from "../support/guard-lab.ts";
import { tempDir } from "../support/run-root.ts";

const TARGET = "captain@worker-host";
const SERVER_ENDED = "server requested disconnect:\n server shutdown";

let lab: GuardLab;

before(async () => {
  lab = await GuardLab.start();
});
after(async () => {
  await lab.stop();
});

async function withAttach(body: (attach: AttachLab) => Promise<void>): Promise<void> {
  const attach = new AttachLab(lab.root);
  try {
    await body(attach);
  } finally {
    attach.stop();
  }
}

const mac = (attach: AttachLab, port = lab.guardPort, extra: readonly string[] = []): Run =>
  attach.attach([TARGET, "--display", ":99", "--guard-port", String(port), ...extra]);

async function leave(run: Run): Promise<void> {
  run.child.kill("SIGTERM");
  assert.equal(await run.exit, 0);
}

test("the captain's Mac attaches through the guard and a closed window leaves the host's tabs running", async () => {
  await withAttach(async (attach) => {
    attach.plan([{ exit: 0 }]);
    const run = mac(attach);
    assert.equal(await run.exit, 0);
    const [args, ...more] = attach.xpraArguments();
    assert.ok(args !== undefined);
    assert.equal(more.length, 0, "a window the captain closed is not attached again");
    assert.ok(args.includes("ssh://captain@worker-host/99"));
    assert.ok(args.includes("--window-close=disconnect"));
    assert.ok(args.includes("--reconnect=no"));
    assert.deepEqual(attach.hostsAsked(), [TARGET]);
  });
});

test("the clipboard of the captain's Mac is shared only when the launcher is asked to", async () => {
  await withAttach(async (attach) => {
    attach.plan([{ exit: 0 }]);
    assert.equal(await mac(attach).exit, 0);
    assert.equal(await mac(attach, lab.guardPort, ["--clipboard"]).exit, 0);
    const [off, on] = attach.xpraArguments();
    assert.ok(off !== undefined && on !== undefined);
    assert.ok(off.includes("--clipboard=no"));
    assert.equal(off.includes("--clipboard=yes"), false);
    assert.ok(on.includes("--clipboard=yes"));
    assert.equal(on.includes("--clipboard=no"), false);
  });
});

test("nothing is attached when the host's DevTools port is not behind the guard", async () => {
  const raw = await StandInChrome.start();
  try {
    await withAttach(async (attach) => {
      attach.plan([{ stay: true }]);
      const run = mac(attach, Number(new URL(raw.endpoint).port));
      assert.equal(await run.exit, 99);
      assert.match(run.output(), /not the guard/);
      assert.equal(attach.xpraArguments().length, 0);
    });
  } finally {
    await raw.stop();
  }
});

test("a dropped link is attached again, and the guard is checked before every attach", async () => {
  await withAttach(async (attach) => {
    attach.plan([{ exit: 1 }, { exit: 1 }, { stay: true }]);
    const run = mac(attach);
    await attach.waitForXpraStarts(3);
    assert.equal(attach.hostsAsked().length, 3);
    assert.match(run.output(), /link to the host dropped/);
    await leave(run);
    assert.equal(attach.xpraWasStopped(), true);
  });
});

test("a session the host ended is attached again, a window the captain closed is not", async () => {
  await withAttach(async (attach) => {
    attach.plan([{ say: SERVER_ENDED, exit: 0 }, { exit: 0 }]);
    const run = mac(attach);
    assert.equal(await run.exit, 0);
    assert.equal(attach.xpraArguments().length, 2);
    assert.match(run.output(), /host ended the session/);
  });
});

test("a failure that waiting will not fix stops the launcher with Xpra's own exit code", async () => {
  await withAttach(async (attach) => {
    attach.plan([{ exit: 5 }]);
    const run = mac(attach);
    assert.equal(await run.exit, 5);
    assert.equal(attach.xpraArguments().length, 1);
  });
});

test("while the guard is down nothing is attached, and the launcher attaches by itself when it is back", async () => {
  await lab.stopGuard();
  try {
    await withAttach(async (attach) => {
      attach.plan([{ stay: true }]);
      const run = mac(attach);
      await attach.waitForHostAsks(3);
      assert.equal(attach.xpraArguments().length, 0);
      assert.match(run.output(), /guard is not answering/);
      await lab.restartGuard();
      await attach.waitForXpraStarts(1);
      await leave(run);
    });
  } finally {
    await lab.restartGuard();
  }
});

test("the host starts Xpra only behind the guard, on one private socket and no network port", async () => {
  await withAttach(async (attach) => {
    attach.plan([{ stay: true }]);
    const runtime = tempDir("xdg-runtime-");
    const run = attach.hostXpra(
      ["--display", ":99", "--guard-port", String(lab.guardPort)],
      runtime,
    );
    await attach.waitForXpraStarts(1);
    const [args] = attach.xpraArguments();
    assert.ok(args !== undefined);
    assert.equal(args[0], "start");
    assert.ok(args.includes(":99"));
    assert.ok(args.includes("--use-display=yes"));
    assert.ok(args.includes("--socket-permissions=600"));
    assert.ok(args.includes("--html=off"));
    assert.ok(args.some((word) => word.startsWith(`--bind=${runtime}/xpra/`)));
    assert.equal(
      args.some((word) => word.startsWith("--bind-tcp") || word.startsWith("--bind-ws")),
      false,
    );
    await lab.stopGuard();
    try {
      assert.equal(await run.exit, 98);
      assert.match(run.output(), /guard stopped answering/);
      await until(() => (attach.xpraWasStopped() ? true : undefined), "Xpra to be stopped");
    } finally {
      await lab.restartGuard();
    }
  });
});

test("the host shares its clipboard with the captain's Mac only when its starter is asked to", async () => {
  await withAttach(async (attach) => {
    attach.plan([{ stay: true }]);
    const runtime = tempDir("xdg-runtime-");
    const guard = ["--display", ":99", "--guard-port", String(lab.guardPort)];
    const off = attach.hostXpra(guard, runtime);
    await attach.waitForXpraStarts(1);
    off.child.kill("SIGTERM");
    await off.exit;
    const on = attach.hostXpra([...guard, "--clipboard"], runtime);
    await attach.waitForXpraStarts(2);
    on.child.kill("SIGTERM");
    await on.exit;
    const [without, withIt] = attach.xpraArguments();
    assert.ok(without !== undefined && withIt !== undefined);
    assert.ok(without.includes("--clipboard=no"));
    assert.equal(without.includes("--clipboard=yes"), false);
    assert.ok(withIt.includes("--clipboard=yes"));
    assert.equal(withIt.includes("--clipboard=no"), false);
  });
});

test("the host does not start Xpra without the guard, or with Chrome itself on the guard's port", async () => {
  await withAttach(async (attach) => {
    attach.plan([{ stay: true }]);
    const runtime = tempDir("xdg-runtime-");
    await lab.stopGuard();
    try {
      const without = attach.hostXpra(
        ["--display", ":99", "--guard-port", String(lab.guardPort)],
        runtime,
      );
      assert.equal(await without.exit, 98);
    } finally {
      await lab.restartGuard();
    }
    const raw = await StandInChrome.start();
    try {
      const port = String(Number(new URL(raw.endpoint).port));
      const unguarded = attach.hostXpra(["--display", ":99", "--guard-port", port], runtime);
      assert.equal(await unguarded.exit, 99);
    } finally {
      await raw.stop();
    }
    assert.equal(attach.xpraArguments().length, 0);
  });
});
