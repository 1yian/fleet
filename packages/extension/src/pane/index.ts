import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { BoardCard } from "@fleet/protocol";
import { boardUrl } from "../board-link.ts";
import type { Link } from "../link.ts";
import { glanceOf, unreachable, type Glance } from "./glance.ts";
import { listOf } from "./list.ts";
import { chips, rowOf, strip } from "./look.ts";
import { PulseView } from "./view.ts";

const STATUS_KEY = "fleet-attention";
const STRIP_KEY = "fleet-strip";
const MINUTE_MS = 60_000;
const DEADLINE_MS = 10_000;
const RETRIES_BEFORE_SILENT = 3;
const CARD_TOOLS: ReadonlySet<string> = new Set(["hold", "comment", "close", "dispatch"]);

interface Settings {
  readonly pollMs: number;
  readonly silentMs: number;
}

function number(name: string, fallback: number): number {
  const set = Number(process.env[name]);
  return Number.isInteger(set) && set > 0 ? set : fallback;
}

const settings = (): Settings => ({
  pollMs: number("FLEET_PANE_POLL_MS", MINUTE_MS),
  silentMs: number("FLEET_PANE_SILENT_MS", 30_000),
});

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

  constructor(link: Link, ctx: ExtensionContext, rules: Settings) {
    this.link = link;
    this.ctx = ctx;
    this.rules = rules;
    this.since = lastMessageAt(ctx);
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
      this.cards = await this.link.call("board", {}, DEADLINE_MS);
      this.silentSince = undefined;
    } catch {
      this.silentSince ??= Date.now();
    }
    this.paint();
  }

  private glance(now: number): Glance | undefined {
    const silent = this.silentSince;
    const down = silent !== undefined && now - silent >= this.rules.silentMs;
    if (down) return { needs: [unreachable(silent)], landed: 0 };
    if (this.cards === undefined) return undefined;
    return glanceOf(this.cards, this.since);
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
    ui.setWidget(STRIP_KEY, row === undefined ? undefined : (_tui, theme) => strip(theme, row));
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
