import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { BoardCard } from "@fleet/protocol";
import { boardUrl } from "../board-link.ts";
import type { Link } from "../link.ts";
import { onStatusClick } from "../status-click.ts";
import { Decide } from "./decide.ts";
import { glanceOf } from "./glance.ts";
import { listOf } from "./list.ts";
import { decisionsText, downStatus, statusOf } from "./look.ts";
import { PulseView } from "./view.ts";
import { Waiting } from "./waiting.ts";

const STATUS_KEY = "fleet-attention";
const MINUTE_MS = 60_000;
const DEADLINE_MS = 10_000;
const LAPSE_SLACK_MS = 1_100;
const RETRIES_BEFORE_SILENT = 3;
const CARD_TOOLS: ReadonlySet<string> = new Set(["hold", "comment", "close", "dispatch"]);

interface Settings {
  readonly pollMs: number;
  readonly silentMs: number;
  readonly liveMs: number;
}

function number(name: string, fallback: number): number {
  const set = Number(process.env[name]);
  return Number.isInteger(set) && set > 0 ? set : fallback;
}

const settings = (): Settings => ({
  pollMs: number("FLEET_PANE_POLL_MS", MINUTE_MS),
  silentMs: number("FLEET_PANE_SILENT_MS", 30_000),
  liveMs: number("FLEET_PANE_LIVE_MS", 5_000),
});

const isMessageOfHis = (entry: SessionEntry): boolean =>
  entry.type === "message" && entry.message.role === "user";

function nextDateRefresh(cards: readonly BoardCard[], readAt: number): number | undefined {
  const refreshes = cards.flatMap(({ datedWait }) => {
    const at = datedWait === null ? 0 : datedWait.until + LAPSE_SLACK_MS;
    return at > readAt ? [at] : [];
  });
  return refreshes.length === 0 ? undefined : Math.min(...refreshes);
}

function lastMessageAt(ctx: ExtensionContext): number {
  const last = ctx.sessionManager.getBranch().findLast(isMessageOfHis);
  const started = ctx.sessionManager.getHeader()?.timestamp;
  const stamp = last?.timestamp ?? started;
  return stamp === undefined ? Date.now() : Date.parse(stamp);
}

class Pane {
  private cards: readonly BoardCard[] | undefined;
  private dateRefreshAt: number | undefined;
  private decisions = 0;
  private since: number;
  private silentSince: number | undefined;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private status: string | undefined;
  private readonly ctx: ExtensionContext;
  private readonly rules: Settings;
  private readonly waiting: Waiting;
  readonly decide: Decide;

  constructor(link: Link, ctx: ExtensionContext, rules: Settings) {
    this.ctx = ctx;
    this.rules = rules;
    this.since = lastMessageAt(ctx);
    this.waiting = new Waiting(link);
    this.waiting.follow(({ cards, decisions, readAt }) => {
      this.cards = cards;
      this.decisions = decisions.length;
      this.dateRefreshAt = nextDateRefresh(cards, readAt);
      this.silentSince = undefined;
      this.paint();
    });
    this.decide = new Decide(
      link,
      this.waiting,
      ctx,
      () => {
        this.refresh();
      },
      rules.liveMs,
    );
  }

  refresh(): void {
    if (this.stopped) return;
    const settle = (): void => {
      this.schedule();
    };
    this.load().then(settle, settle);
  }

  schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const { pollMs, silentMs } = this.rules;
    const retry = Math.ceil(silentMs / RETRIES_BEFORE_SILENT);
    const answering = this.silentSince === undefined;
    const poll = answering ? pollMs : Math.min(pollMs, retry);
    const date =
      answering && this.dateRefreshAt !== undefined ? this.dateRefreshAt - Date.now() : poll;
    this.timer = setTimeout(
      () => {
        this.refresh();
      },
      Math.max(Math.min(poll, date), 0),
    );
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
    onStatusClick(STATUS_KEY, undefined);
  }

  private async load(): Promise<void> {
    try {
      await this.waiting.read();
    } catch {
      this.silentSince ??= Date.now();
      this.paint();
    }
  }

  private statusAt(now: number): { text: string; decisions: number } | undefined {
    const { theme } = this.ctx.ui;
    const silent = this.silentSince;
    if (silent !== undefined && now - silent >= this.rules.silentMs)
      return { text: downStatus(theme), decisions: 0 };
    if (this.cards === undefined) return undefined;
    const glance = glanceOf(this.cards, this.since);
    return { text: statusOf(theme, glance, this.decisions), decisions: this.decisions };
  }

  private paint(): void {
    const shown = this.statusAt(Date.now());
    if (shown === undefined || this.stopped) return;
    if (shown.text !== this.status) {
      this.ctx.ui.setStatus(STATUS_KEY, shown.text || undefined);
      this.status = shown.text;
    }
    const waiting = decisionsText(shown.decisions);
    onStatusClick(
      STATUS_KEY,
      waiting === undefined
        ? undefined
        : {
            text: waiting,
            act: () => {
              void this.decide.open();
            },
          },
    );
  }
}

const OVERLAY = { width: "80%", minWidth: 56, maxHeight: "90%" } as const;
const SHARE_OF_SCREEN = 0.9;

async function showPulse(link: Link, ctx: ExtensionCommandContext, carddUrl: string) {
  const cards = await link.call("board", {}, DEADLINE_MS).catch(() => undefined);
  if (cards === undefined) {
    ctx.ui.notify("cardd is not answering, so there is no pulse to show", "error");
    return;
  }
  const base = boardUrl(carddUrl);
  const links = { urlOf: (card: number): string => `${base}#/c-${String(card)}` };
  const list = listOf(cards);
  const picked = await ctx.ui.custom<number | undefined>(
    (tui, theme, _keys, done) =>
      new PulseView(
        theme,
        list,
        links,
        () => Math.floor(tui.terminal.rows * SHARE_OF_SCREEN),
        done,
      ),
    { overlay: true, overlayOptions: OVERLAY },
  );
  if (picked !== undefined) ctx.ui.notify(`c-${String(picked)}: ${links.urlOf(picked)}`, "info");
}

export function showPane(
  pi: ExtensionAPI,
  link: Link,
  ctx: ExtensionContext,
  carddUrl: string,
): void {
  if (!ctx.hasUI) return;
  pi.registerCommand("pulse", {
    description: "Every open card, quiet ones first. It stays out of the chat.",
    handler: (_args, command) => showPulse(link, command, carddUrl),
  });
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
