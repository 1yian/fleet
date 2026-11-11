import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Link } from "../link.ts";
import { DecisionCard } from "./card.ts";
import { answerDecision, loadDecisions } from "./decisions.ts";

const RESERVED_ROWS = 5;
const NOTHING_WAITING = "Nothing is waiting for your decision.";

export interface DecideEvents {
  readonly opened: () => void;
  readonly closed: () => void;
}

export class Decide {
  private showing = false;
  private readonly link: Link;
  private readonly ctx: ExtensionContext;
  private readonly events: DecideEvents;

  constructor(link: Link, ctx: ExtensionContext, events: DecideEvents) {
    this.link = link;
    this.ctx = ctx;
    this.events = events;
  }

  get isOpen(): boolean {
    return this.showing;
  }

  async open(): Promise<void> {
    if (this.showing) return;
    this.showing = true;
    const { ui } = this.ctx;
    try {
      const decisions = await loadDecisions(this.link);
      if (decisions.length === 0) {
        ui.notify(NOTHING_WAITING, "info");
        return;
      }
      this.events.opened();
      await ui.custom<undefined>(
        (tui, theme, keys, done) =>
          new DecisionCard({
            theme,
            keys,
            decisions,
            rows: () => tui.terminal.rows - RESERVED_ROWS,
            send: (decision, choice, written) =>
              answerDecision(this.link, decision, choice, written),
            reload: () => loadDecisions(this.link),
            redraw: () => {
              tui.requestRender();
            },
            close: () => {
              done(undefined);
            },
          }),
      );
    } catch (error) {
      ui.notify(
        `Decisions could not be read: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      this.showing = false;
      this.events.closed();
    }
  }
}
