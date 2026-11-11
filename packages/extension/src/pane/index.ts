import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BoardCard, CardView } from "@fleet/protocol";
import type { Link } from "../link.ts";
import { Decide } from "./decide.ts";
import { glanceOf, unreachable, type Glance, type Limits, type ReportTimes } from "./glance.ts";
import { chips, rowOf, strip } from "./look.ts";

const STATUS_KEY = "fleet-attention";
const STRIP_KEY = "fleet-strip";
const MINUTE_MS = 60_000;
const DEADLINE_MS = 10_000;
const RETRIES_BEFORE_SILENT = 3;
const CARD_TOOLS: ReadonlySet<string> = new Set(["hold", "comment", "close", "dispatch"]);

interface Settings {
  readonly pollMs: number;
  readonly silentMs: number;
  readonly limits: Limits;
}

function number(name: string, fallback: number): number {
  const set = Number(process.env[name]);
  return Number.isInteger(set) && set > 0 ? set : fallback;
}

const settings = (): Settings => ({
  pollMs: number("FLEET_PANE_POLL_MS", MINUTE_MS),
  silentMs: number("FLEET_PANE_SILENT_MS", 30_000),
  limits: {
    stallMs: number("FLEET_PANE_STALL_MS", 5 * MINUTE_MS),
    lostMs: number("FLEET_PANE_LOST_MS", 2 * MINUTE_MS),
  },
});

const reportKey = (card: BoardCard): string => `${String(card.id)}:${String(card.revision)}`;

const reportedAt = ({ card, entries }: CardView): number | undefined =>
  entries.findLast((entry) => entry.kind === "report" && entry.fields["status"] === card.attention)
    ?.createdAt;

const isMessageOfHis = (entry: SessionEntry): boolean =>
  entry.type === "message" && entry.message.role === "user";

function lastMessageAt(ctx: ExtensionContext): number {
  const last = ctx.sessionManager.getBranch().findLast(isMessageOfHis);
  const started = ctx.sessionManager.getHeader()?.timestamp;
  const stamp = last?.timestamp ?? started;
  return stamp === undefined ? Date.now() : Date.parse(stamp);
}

class Pane {
  private cards: readonly BoardCard[] | undefined;
  private readonly reported = new Map<string, number>();
  private since: number;
  private silentSince: number | undefined;
  private fetching = false;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private status: string | undefined;
  private row: string | undefined;
  private readonly link: Link;
  private readonly ctx: ExtensionContext;
  private readonly rules: Settings;
  readonly decide: Decide;

  constructor(link: Link, ctx: ExtensionContext, rules: Settings) {
    this.link = link;
    this.ctx = ctx;
    this.rules = rules;
    this.since = lastMessageAt(ctx);
    this.decide = new Decide(link, ctx, () => {
      this.refresh();
    });
  }

  refresh(): void {
    if (this.stopped) return;
    if (this.fetching) {
      this.again = true;
      return;
    }
    this.fetching = true;
    const settle = (): void => {
      this.fetching = false;
      if (!this.again) {
        this.schedule();
        return;
      }
      this.again = false;
      this.refresh();
    };
    this.load().then(settle, settle);
  }

  schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const { pollMs, silentMs } = this.rules;
    const retry = Math.ceil(silentMs / RETRIES_BEFORE_SILENT);
    const wait = this.silentSince === undefined ? pollMs : Math.min(pollMs, retry);
    this.timer = setTimeout(() => {
      this.refresh();
    }, wait);
    this.timer.unref();
  }

  heard(at: number): void {
    this.since = at;
    this.paint();
  }

  stop(ctx: ExtensionContext): void {
    this.stopped = true;
    clearTimeout(this.timer);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STRIP_KEY, undefined);
  }

  private async load(): Promise<void> {
    try {
      const cards = await this.link.call("board", {}, DEADLINE_MS);
      await this.learn(cards);
      this.cards = cards;
      this.silentSince = undefined;
    } catch {
      this.silentSince ??= Date.now();
    }
    this.paint();
  }

  private async learn(cards: readonly BoardCard[]): Promise<void> {
    const flagged = cards.filter((card) => card.attention !== null);
    const current = new Set(flagged.map(reportKey));
    for (const key of this.reported.keys()) if (!current.has(key)) this.reported.delete(key);
    const unread = flagged.filter((card) => !this.reported.has(reportKey(card)));
    await Promise.all(unread.map((card) => this.read(card)));
  }

  private async read(card: BoardCard): Promise<void> {
    try {
      const at = reportedAt(await this.link.call("card", { card: card.id }, DEADLINE_MS));
      if (at !== undefined) this.reported.set(reportKey(card), at);
    } catch {
      return;
    }
  }

  private reportTimes(cards: readonly BoardCard[]): ReportTimes {
    return new Map(
      cards.flatMap((card) => {
        const at = this.reported.get(reportKey(card));
        return at === undefined ? [] : [[card.id, at] as const];
      }),
    );
  }

  private glance(now: number): Glance | undefined {
    const silent = this.silentSince;
    const down = silent !== undefined && now - silent >= this.rules.silentMs;
    if (down) return { needs: [unreachable(silent)], landed: 0 };
    if (this.cards === undefined) return undefined;
    const reports = this.reportTimes(this.cards);
    return glanceOf(this.cards, now, this.since, this.rules.limits, reports);
  }

  private paint(): void {
    const now = Date.now();
    const glance = this.glance(now);
    if (glance === undefined || this.stopped) return;
    const { ui } = this.ctx;
    const status = chips(ui.theme, glance);
    if (status !== this.status) {
      ui.setStatus(STATUS_KEY, status);
      this.status = status;
    }
    const row = rowOf(glance.needs, now);
    const key = row === undefined ? "" : JSON.stringify(row);
    if (key === this.row) return;
    this.row = key;
    const open = (): void => {
      void this.decide.open();
    };
    ui.setWidget(
      STRIP_KEY,
      row === undefined ? undefined : (_tui, theme) => strip(theme, row, open),
    );
  }
}

export function showPane(pi: ExtensionAPI, link: Link, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  const rules = settings();
  const pane = new Pane(link, ctx, rules);
  const refresh = (): void => {
    pane.refresh();
  };
  pi.registerCommand("d", {
    description: "Answer the decisions that wait for you, one at a time",
    handler: () => pane.decide.open(),
  });
  pi.events.on("fleet:connected", refresh);
  pi.events.on("fleet:delivered", refresh);
  pi.on("tool_execution_end", (event) => {
    if (CARD_TOOLS.has(event.toolName)) pane.refresh();
  });
  pi.on("input", (event) => {
    if (event.source === "interactive") pane.heard(Date.now());
  });
  pi.on("session_shutdown", (_event, ended) => {
    pane.stop(ended);
  });
  pane.schedule();
}
