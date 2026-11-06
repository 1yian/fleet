import { appendFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

const REPORT_MS = 1000;
const RESOLUTION_MS = 10;
const NS_PER_MS = 1e6;

export default function loopLag(): void {
  const file = process.env["LOOP_LAG_FILE"];
  if (file === undefined) return;
  const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  delay.enable();
  setInterval(() => {
    appendFileSync(file, `${String(delay.percentile(99) / NS_PER_MS)}\n`);
    delay.reset();
  }, REPORT_MS).unref();
}
