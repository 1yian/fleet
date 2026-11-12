import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Link } from "../link.ts";
import { DecisionCard } from "./card.ts";
import { answerDecision, deferDecision } from "./decisions.ts";
import type { Waiting } from "./waiting.ts";

const RESERVED_ROWS = 5;

export class Decide {
  private showing = false;
  private readonly link: Link;
  private readonly waiting: Waiting;
  private readonly ctx: ExtensionContext;
  private readonly closed: () => void;
  private readonly liveMs: number;

  constructor(
    link: Link,
    waiting: Waiting,
    ctx: ExtensionContext,
    closed: () => void,
    liveMs: number,
  ) {
    this.link = link;
    this.waiting = waiting;
    this.ctx = ctx;
    this.closed = closed;
    this.liveMs = liveMs;
  }

  async open(): Promise<void> {
    if (this.showing) return;
    this.showing = true;
    const { ui } = this.ctx;
    try {
      await this.waiting.read();
      let card: DecisionCard | undefined;
      const unfollow = this.waiting.follow(({ decisions }) => card?.sync(decisions));
      const poll = setInterval(() => {
        this.waiting.read().catch(() => undefined);
      }, this.liveMs);
      try {
        await ui.custom<undefined>((tui, theme, keys, done) => {
          card = new DecisionCard({
            theme,
            keys,
            decisions: this.waiting.latest?.decisions ?? [],
            rows: () => tui.terminal.rows - RESERVED_ROWS,
            send: (decision, choice, written) =>
              answerDecision(this.link, decision, choice, written),
            later: async (decision, said) => {
              ui.notify(await deferDecision(this.link, decision, said), "info");
            },
            reload: async () => (await this.waiting.read()).decisions,
            refresh: () => {
              this.waiting.read().catch(() => undefined);
            },
            redraw: () => {
              tui.requestRender();
            },
            close: () => {
              done(undefined);
            },
          });
          return card;
        });
      } finally {
        clearInterval(poll);
        unfollow();
      }
    } catch (error) {
      ui.notify(
        `Decisions could not be read: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      this.showing = false;
      this.closed();
    }
  }
}
