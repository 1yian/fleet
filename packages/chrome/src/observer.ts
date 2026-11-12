import type { Cdp } from "@fleet/protocol";
import { Scanner } from "./roots.ts";
import { Loads } from "./tracking.ts";

export interface Pages {
  hold(session: string): void;
  release(session: string): void;
  waiting(): Iterable<string>;
  defaults(session: string): number[];
}

export class Observer {
  private readonly scanner = new Scanner();
  private readonly loads: Loads;
  private readonly busy = new Set<string>();
  private readonly enrolled = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly pages: Pages;

  constructor(pages: Pages, parseWaitMs: number) {
    this.pages = pages;
    this.loads = new Loads(parseWaitMs);
  }

  observed(session: string): boolean {
    return this.seen.has(session);
  }

  hold(session: string): void {
    this.pages.hold(session);
    this.loads.mark(session);
  }

  started(session: string, frame: string): void {
    this.loads.begin(session, frame);
    this.hold(session);
  }

  navigated(session: string): void {
    this.loads.invalidate(session);
    this.hold(session);
  }

  parsed(cdp: Cdp, session: string, frame: string): void {
    this.loads.parsed(session, frame);
    this.rescan(cdp, session);
  }

  rescan(cdp: Cdp, session: string): void {
    if (this.enrolled.has(session)) this.look(cdp, session);
  }

  retry(cdp: Cdp): void {
    const sessions = new Set([...this.pages.waiting(), ...this.loads.loading()]);
    for (const session of sessions)
      if (this.enrolled.has(session) && !this.busy.has(session)) this.look(cdp, session);
  }

  async enrol(cdp: Cdp, session: string): Promise<void> {
    this.enrolled.add(session);
    await this.observe(cdp, session);
  }

  forget(session: string): void {
    this.enrolled.delete(session);
    this.seen.delete(session);
    this.busy.delete(session);
    this.scanner.forget(session);
    this.loads.forget(session);
  }

  clear(): void {
    this.enrolled.clear();
    this.seen.clear();
    this.busy.clear();
    this.scanner.clear();
    this.loads.clear();
  }

  private look(cdp: Cdp, session: string): void {
    this.observe(cdp, session).catch((error: unknown) => {
      if (this.enrolled.has(session)) this.hold(session);
      console.error(`guard: cannot finish looking at a page: ${String(error)}`);
    });
  }

  private async observe(cdp: Cdp, session: string): Promise<void> {
    this.busy.add(session);
    try {
      const generation = this.loads.generation(session);
      if (!this.loads.awaitingEvents(session))
        this.loads.probed(
          session,
          await this.scanner.parsed(cdp, session, this.pages.defaults(session)),
        );
      const parsed = this.loads.overdue(session) || !this.loads.waiting(session);
      await this.scanner.scan(cdp, session);
      this.seen.add(session);
      if (parsed && generation === this.loads.generation(session)) {
        this.loads.done(session);
        this.pages.release(session);
      }
    } finally {
      this.busy.delete(session);
    }
  }
}
