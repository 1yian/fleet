import { herdr, quote, shellIdle } from "./host.ts";

const WAIT_MS = 60_000;
const [pid = "", pane = "", home = "", ...args] = process.argv.slice(2);

const alive = (): boolean => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`main's restart gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

await until(() => !alive(), `main's Pi (pid ${pid}) to exit`);
await until(() => shellIdle("local", pane), `the shell in pane ${pane}`);
const command = ["pi", "--continue", ...args].map(quote).join(" ");
await herdr("local", ["pane", "run", pane, `cd ${quote(home)} && ${command}`]);
