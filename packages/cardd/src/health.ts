import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Health } from "@fleet/protocol";

const NS = 1e6;
const WATCH_MS = 100;
const LAG_LOG_MS = 1000;
const TICK_BUDGET_MS = 500;
const SUMMARY_MS = 5 * 60_000;

export interface Gauges {
  readonly sockets: () => number;
  readonly sessions: () => number;
}

interface Longest {
  ms: number;
  ran: string;
}

const ms = (ns: number): number => Math.round((ns / NS) * 10) / 10;

export class LoopHealth {
  private readonly live = monitorEventLoopDelay({ resolution: 10 });
  private expected: number;
  private windowStart: number;
  private lastLagMs = 0;
  private lastLagAt: number | null = null;
  private lastTickMs = 0;
  private longest: Longest = { ms: 0, ran: "none" };
  private accepted = 0;
  private readonly gauges: Gauges;
  private readonly commit: string | null;
  private readonly log: (line: string) => void;

  constructor(
    gauges: Gauges,
    commit: string | null,
    log: (line: string) => void = console.log.bind(console),
  ) {
    this.gauges = gauges;
    this.commit = commit;
    this.log = log;
    this.windowStart = Date.now();
    this.live.enable();
    this.expected = performance.now() + WATCH_MS;
    setInterval(() => {
      this.watch();
    }, WATCH_MS).unref();
    setInterval(() => {
      this.summarize();
    }, SUMMARY_MS).unref();
  }

  accept(): void {
    this.accepted += 1;
  }

  tick(took: number, ran: string): void {
    this.lastTickMs = took;
    if (took > this.longest.ms) this.longest = { ms: took, ran };
    if (took > TICK_BUDGET_MS)
      this.log(
        `warning: check took ${String(Math.round(took))} ms, over ${String(TICK_BUDGET_MS)} ms (slowest part: ${ran})`,
      );
  }

  private watch(): void {
    const now = performance.now();
    const late = ms((now - this.expected) * NS);
    this.expected = now + WATCH_MS;
    if (late <= LAG_LOG_MS) return;
    this.lastLagMs = late;
    this.lastLagAt = Date.now();
    this.log(
      `warning: event loop lag ${String(late)} ms, p99 ${String(ms(this.live.percentile(99)))} ms, max ${String(ms(this.live.max))} ms`,
    );
  }

  private stats(): { p50: number; p99: number; max: number } {
    if (this.live.count === 0) return { p50: 0, p99: 0, max: 0 };
    return {
      p50: ms(this.live.percentile(50)),
      p99: ms(this.live.percentile(99)),
      max: ms(this.live.max),
    };
  }

  snapshot(): Health {
    const { p50, p99, max } = this.stats();
    return {
      commit: this.commit,
      now: Date.now(),
      windowStart: this.windowStart,
      loopP50Ms: p50,
      loopP99Ms: p99,
      loopMaxMs: max,
      lastLagMs: this.lastLagMs,
      lastLagAt: this.lastLagAt,
      lastTickMs: Math.round(this.lastTickMs),
      longestTickMs: Math.round(this.longest.ms),
      sockets: this.gauges.sockets(),
      sessions: this.gauges.sessions(),
      rssBytes: process.memoryUsage().rss,
    };
  }

  private summarize(): void {
    const health = this.snapshot();
    this.log(
      `health: loop p50 ${String(health.loopP50Ms)} ms, p99 ${String(health.loopP99Ms)} ms, max ${String(health.loopMaxMs)} ms; longest tick ${String(health.longestTickMs)} ms (${this.longest.ran}); accepted ${String(this.accepted)}; sockets ${String(health.sockets)}; sessions ${String(health.sessions)}; rss ${String(Math.round(health.rssBytes / 1048576))} MB`,
    );
    this.live.reset();
    this.windowStart = Date.now();
    this.longest = { ms: 0, ran: "none" };
    this.accepted = 0;
  }
}
