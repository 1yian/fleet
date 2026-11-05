import type { DatabaseSync } from "node:sqlite";
import type { BrowserArgs, OpResult } from "@fleet/protocol";
import type { BrowserConfig } from "./browser-config.ts";
import { HostBrowser, plural, type Outcome } from "./browser-host.ts";
import {
  attemptHost,
  hostsEverUsed,
  hostsOfCard,
  openTabs,
  retireTabs,
  tabsOf,
  type Tab,
} from "./browser-store.ts";
import { tabView, type Listed } from "./browser-targets.ts";
import { routeFor } from "./merged-report.ts";
import type { Hosts } from "./pulls.ts";

export type { Outcome };

const NO_BROWSER =
  "this fleet has no shared browser configured: cardd was started without --browser, so the browser is not available";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class Browser {
  private readonly sites = new Map<string, HostBrowser>();
  private readonly turns = new Map<number, Promise<unknown>>();
  private readonly db: DatabaseSync;
  private readonly config: BrowserConfig | undefined;
  private readonly hosts: Hosts;

  constructor(db: DatabaseSync, config: BrowserConfig | undefined, hosts: Hosts) {
    this.db = db;
    this.config = config;
    this.hosts = hosts;
  }

  configured(): { host: string; endpoint: string }[] {
    return Object.entries(this.config ?? {}).map(([host, { cdp }]) => ({ host, endpoint: cdp }));
  }

  hostOf(card: number, declared: string | undefined): string | undefined {
    return attemptHost(this.db, card) ?? declared;
  }

  async view(
    wants: (card: number) => boolean,
    captain: boolean,
    host: string | undefined,
  ): Promise<OpResult<"browser.view">> {
    this.touchUsedHosts();
    const shown = openTabs(this.db).filter((tab) => wants(tab.card) && this.configuredOn(tab.host));
    const hosts = new Set(shown.map((tab) => tab.host));
    if (host !== undefined && this.configuredOn(host)) hosts.add(host);
    const listed = new Map(
      await Promise.all(
        [...hosts].map(async (each) => [each, await this.listingOf(each, captain)] as const),
      ),
    );
    const tabs = shown.map((tab) => {
      const there = listed.get(tab.host);
      return tabView(this.db, tab, there?.targets ?? new Map(), there?.hide ?? (() => ""));
    });
    const problems = [...listed.values()].flatMap(({ problem }) => problem ?? []);
    return {
      host: host ?? null,
      browsers: this.configured(),
      problem: problems.length === 0 ? null : problems.join(" "),
      tabs,
    };
  }

  hasTab(card: number, declared: string | undefined): boolean {
    const tab = this.liveTab(card, declared);
    if (tab === undefined || !this.configuredOn(tab.host)) return false;
    try {
      return this.site(tab.host).hasTab(card);
    } catch {
      return false;
    }
  }

  private liveTab(card: number, declared: string | undefined): Tab | undefined {
    const host = this.hostOf(card, declared);
    return host === undefined ? undefined : tabsOf(this.db, card, host)[0];
  }

  frame(card: number, target: string): Promise<OpResult<"browser.frame">> {
    return this.inTurn(card, async () => {
      try {
        const tab = openTabs(this.db).find((each) => each.card === card && each.target === target);
        if (tab === undefined) throw new Error("that tab is not open");
        return await this.site(tab.host).frame(card, target);
      } catch (error) {
        return { image: null, note: reason(error) };
      }
    });
  }

  private async listingOf(
    host: string,
    captain: boolean,
  ): Promise<{
    targets: Map<string, Listed>;
    problem: string | null;
    hide: (text: string) => string;
  }> {
    try {
      const site = this.site(host);
      return { ...(await site.listing()), hide: site.hider(captain) };
    } catch (error) {
      return { targets: new Map(), problem: reason(error), hide: () => "" };
    }
  }

  run(card: number, args: BrowserArgs, declared: string | undefined): Promise<Outcome> {
    if (this.config === undefined) return Promise.reject(new Error(NO_BROWSER));
    return this.inTurn(card, () => this.perform(card, args, declared));
  }

  release(card: number): Promise<OpResult<"browser.release">> {
    return this.inTurn(card, () => this.closeEverywhere(card));
  }

  private touchUsedHosts(): void {
    for (const used of hostsEverUsed(this.db)) {
      try {
        this.site(used).touch();
      } catch {
        continue;
      }
    }
  }

  private configuredOn(host: string): boolean {
    return this.config !== undefined && Object.hasOwn(this.config, host);
  }

  private site(host: string): HostBrowser {
    const known = this.sites.get(host);
    if (known !== undefined) return known;
    const config = this.config;
    if (config === undefined) throw new Error(NO_BROWSER);
    const own = Object.hasOwn(config, host) ? config[host] : undefined;
    if (own === undefined)
      throw new Error(
        `this fleet has no shared browser configured on host ${host}: cardd's --browser names ${Object.keys(config).join(", ")}. Nothing was opened`,
      );
    let via: readonly string[];
    try {
      via = routeFor(this.hosts, host);
    } catch (error) {
      throw new Error(
        `the browser on ${host} cannot be reached: ${reason(error)}. Add ${host} to cardd's --hosts, or run cardd on ${host}`,
        { cause: error },
      );
    }
    const made = new HostBrowser(this.db, host, own, via);
    this.sites.set(host, made);
    return made;
  }

  private inTurn<T>(card: number, work: () => Promise<T>): Promise<T> {
    const before = this.turns.get(card) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(work);
    this.turns.set(card, next);
    next
      .catch(() => undefined)
      .finally(() => {
        if (this.turns.get(card) === next) this.turns.delete(card);
      })
      .catch(() => undefined);
    return next;
  }

  private async perform(
    card: number,
    args: BrowserArgs,
    declared: string | undefined,
  ): Promise<Outcome> {
    if (args.action === "close") return this.closeOwn(card);
    if (args.action === "open") return this.open(card, args, declared);
    const tab = this.liveTab(card, declared);
    if (tab === undefined)
      throw new Error("you have no tab yet: call browser with action open first");
    return this.site(tab.host).perform(card, args);
  }

  private async open(
    card: number,
    args: BrowserArgs,
    declared: string | undefined,
  ): Promise<Outcome> {
    const host = this.hostOf(card, declared);
    if (host === undefined)
      throw new Error(
        `c-${String(card)} has no worker, so name the host whose browser it uses: pass the host (--host NAME). cardd's --browser names ${Object.keys(this.config ?? {}).join(", ")}`,
      );
    const site = this.site(host);
    for (const other of hostsOfCard(this.db, card).filter((each) => each !== host))
      await this.closeOn(other, card);
    return site.perform(card, args);
  }

  private async closeOn(host: string, card: number): Promise<OpResult<"browser.release">> {
    let site: HostBrowser | undefined;
    let why = `the browser on ${host} is not configured any more`;
    if (this.configuredOn(host)) {
      try {
        site = this.site(host);
      } catch (error) {
        why = reason(error);
      }
    }
    if (site !== undefined) return site.closeTabs(card);
    const left = retireTabs(this.db, card, host);
    return {
      closed: 0,
      note:
        left === 0
          ? null
          : `${why}. ${plural(left)} of c-${String(card)} stay open there: cardd closes them when the browser on ${host} can be reached again.`,
    };
  }

  private async closeEverywhere(card: number): Promise<OpResult<"browser.release">> {
    let closed = 0;
    const notes: string[] = [];
    for (const host of hostsOfCard(this.db, card)) {
      const done = await this.closeOn(host, card);
      closed += done.closed;
      if (done.note !== null) notes.push(done.note);
    }
    return { closed, note: notes.length === 0 ? null : notes.join(" ") };
  }

  private async closeOwn(card: number): Promise<Outcome> {
    const { closed, note } = await this.closeEverywhere(card);
    if (note !== null)
      throw new Error(
        `Your tab was not closed and stays open. ${note} Call close again when the browser answers.`,
      );
    return {
      result: { text: closed > 0 ? "Closed your tab." : "You had no tab open." },
      notify: [],
    };
  }
}
