import { observeReload } from "./reload-observer.ts";

const [pid = "", pane = "", home = "", ...args] = process.argv.slice(2);

await observeReload({ pid: Number(pid), pane, home }, async () => {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0 || pane === "" || home === "")
    throw new Error("reload requires a positive process PID, pane and home");
  const { runRelaunch } = await import("./relaunch-run.ts");
  await runRelaunch(Number(pid), pane, home, args);
});
