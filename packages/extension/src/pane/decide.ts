import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayOptions } from "@earendil-works/pi-tui";
import type { Link } from "../link.ts";
import { DecisionCard } from "./card.ts";
import { answerDecision, loadDecisions } from "./decisions.ts";

const MARGIN = 1;
const OVERLAY: OverlayOptions = { width: 78, minWidth: 40, margin: MARGIN };
const NOTHING_WAITING = "Nothing is waiting for your decision.";

export class Decide {
  private opened = false;
  private readonly link: Link;
  private readonly ctx: ExtensionContext;
  private readonly closed: () => void;

  constructor(link: Link, ctx: ExtensionContext, closed: () => void) {
    this.link = link;
    this.ctx = ctx;
    this.closed = closed;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    const { ui } = this.ctx;
    try {
      const decisions = await loadDecisions(this.link);
      if (decisions.length === 0) {
        ui.notify(NOTHING_WAITING, "info");
        return;
      }
      await ui.custom<undefined>(
        (tui, theme, keys, done) =>
          new DecisionCard({
            theme,
            keys,
            decisions,
            rows: () => tui.terminal.rows - 2 * MARGIN,
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
        { overlay: true, overlayOptions: OVERLAY },
      );
    } catch (error) {
      ui.notify(
        `Decisions could not be read: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      this.opened = false;
      this.closed();
    }
  }
}
