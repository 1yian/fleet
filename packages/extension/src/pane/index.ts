import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { BoardCard } from "@fleet/protocol";
import type { Link } from "../link.ts";
import { onStatusClick, type StatusClick } from "../status-click.ts";
import { showCards } from "./cards.ts";
import { Decide } from "./decide.ts";
import { glanceOf, type Glance } from "./glance.ts";
import { listOf, listOfCounted } from "./list.ts";
import { COUNTED, downStatus, itemsOf, statusOf, type Counted } from "./look.ts";
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

function nextDateRefresh(cards: readonly BoardCard[], readAt: number): number | undefined {
  const refreshes = cards.flatMap(({ datedWait }) => {
    const at = datedWait === null ? 0 : datedWait.until + LAPSE_SLACK_MS;
    return at > readAt ? [at] : [];
  });
  return refreshes.length === 0 ? undefined : Math.min(...refreshes);
}

interface Shown {
  readonly text: string;
  readonly clicks: ReadonlyMap<Counted, StatusClick>;
}

function setClicks(clicks: ReadonlyMap<Counted, StatusClick>): void {
  for (const key of COUNTED) onStatusClick(`${STATUS_KEY}/${key}`, clicks.get(key));
}

class Pane {
  private cards: readonly BoardCard[] | undefined;
  private dateRefreshAt: number | undefined;
  private decisions = 0;
  private listing = false;
  private silentSince: number | undefined;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private status: string | undefined;
  private readonly ctx: ExtensionContext;
  private readonly carddUrl: string;
  private readonly rules: Settings;
  private readonly waiting: Waiting;
  readonly decide: Decide;

  constructor(link: Link, ctx: ExtensionContext, carddUrl: string, rules: Settings) {
    this.ctx = ctx;
    this.carddUrl = carddUrl;
    this.rules = rules;
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

  stop(ctx: ExtensionContext): void {
    this.stopped = true;
    clearTimeout(this.timer);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    setClicks(new Map());
  }

  private async load(): Promise<void> {
    try {
      await this.waiting.read();
    } catch {
      this.silentSince ??= Date.now();
      this.paint();
    }
  }

  private statusAt(now: number): Shown | undefined {
    const { theme } = this.ctx.ui;
    const silent = this.silentSince;
    if (silent !== undefined && now - silent >= this.rules.silentMs)
      return { text: downStatus(theme), clicks: new Map() };
    if (this.cards === undefined) return undefined;
    const glance = glanceOf(this.cards);
    const items = itemsOf(theme, glance, this.decisions);
    const clicks = new Map(
      items.map(({ key, text }) => [
        key,
        {
          text,
          act: () => {
            this.open(key, glance, text);
          },
        },
      ]),
    );
    return { text: statusOf(items), clicks };
  }

  private paint(): void {
    const shown = this.statusAt(Date.now());
    if (shown === undefined || this.stopped) return;
    if (shown.text !== this.status) {
      this.ctx.ui.setStatus(STATUS_KEY, shown.text || undefined);
      this.status = shown.text;
    }
    setClicks(shown.clicks);
  }

  private open(key: Counted, glance: Glance, text: string): void {
    if (key === "decisions") {
      void this.decide.open();
      return;
    }
    if (this.listing) return;
    this.listing = true;
    const failed = (error: unknown): void => {
      const reason = error instanceof Error ? error.message : String(error);
      this.ctx.ui.notify(`The list could not be shown: ${reason}`, "error");
    };
    showCards(this.ctx, listOfCounted(glance[key], text), this.carddUrl)
      .catch(failed)
      .finally(() => {
        this.listing = false;
      });
  }
}

async function showPulse(link: Link, ctx: ExtensionCommandContext, carddUrl: string) {
  const cards = await link.call("board", {}, DEADLINE_MS).catch(() => undefined);
  if (cards === undefined) {
    ctx.ui.notify("cardd is not answering, so there is no pulse to show", "error");
    return;
  }
  await showCards(ctx, listOf(cards), carddUrl);
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
  const pane = new Pane(link, ctx, carddUrl, rules);
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
  pi.on("session_shutdown", (_event, ended) => {
    pane.stop(ended);
  });
  pane.schedule();
}
