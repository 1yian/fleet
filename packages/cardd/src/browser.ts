import type { DatabaseSync } from "node:sqlite";
import { Cdp, parseCdp, type BrowserArgs, type OpResult } from "@fleet/protocol";
import Type from "typebox";
import type { BrowserConfig, LoginsConfig } from "./browser-config.ts";
import { scrubbed } from "./browser-hidden.ts";
import { initScript } from "./browser-init.ts";
import { login, valuesCovering } from "./browser-login.ts";
import {
  checkedUrl,
  clickPage,
  cut,
  documentOf,
  navigate,
  pressKey,
  readPage,
  runExpression,
  typeText,
  type Page,
} from "./browser-page.ts";
import { screenshot } from "./browser-shot.ts";
import {
  attemptStartedAt,
  cardEnded,
  labelOf,
  markClosed,
  openTabs,
  recordTab,
  tabsOf,
  type Tab,
} from "./browser-store.ts";
import type { Hosts } from "./pulls.ts";
import { getCard, type Session } from "./store.ts";

export interface Outcome {
  readonly result: OpResult<"browser">;
  readonly notify: readonly string[];
}

const AttachedSchema = Type.Object({ sessionId: Type.String() });
const CreatedSchema = Type.Object({ targetId: Type.String() });
const TargetsSchema = Type.Object({
  targetInfos: Type.Array(Type.Object({ targetId: Type.String() })),
});
const TargetEventSchema = Type.Object({
  targetInfo: Type.Object({
    targetId: Type.String(),
    type: Type.String(),
    openerId: Type.Optional(Type.String()),
  }),
});
const DestroyedSchema = Type.Object({ targetId: Type.String() });

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isGone = (error: unknown): boolean =>
  /no target (with given id|found for targetId)/i.test(reason(error));
const plural = (count: number): string => `${String(count)} tab${count === 1 ? "" : "s"}`;
const plain = (text: string): Outcome => ({ result: { text }, notify: [] });

export class Browser {
  private link: Promise<Cdp> | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly hidden = new Map<number, Set<string>>();
  private readonly retired = new Set<string>();
  private readonly turns = new Map<number, Promise<unknown>>();
  private readonly db: DatabaseSync;
  private readonly config: BrowserConfig | undefined;
  private readonly hosts: Hosts;

  constructor(db: DatabaseSync, config: BrowserConfig | undefined, hosts: Hosts) {
    this.db = db;
    this.config = config;
    this.hosts = hosts;
  }

  view(): OpResult<"browser.view"> {
    this.connection().catch(() => undefined);
    const tabs = openTabs(this.db).map((tab) => ({
      card: tab.card,
      name: getCard(this.db, tab.card).name,
      label: tab.label,
      target: tab.target,
    }));
    return { endpoint: this.config?.cdp ?? null, tabs };
  }

  run(session: Session, args: BrowserArgs): Promise<Outcome> {
    const card = session.card;
    if (card === null)
      return Promise.reject(new Error("only a worker on a card can use the browser"));
    if (this.config === undefined)
      return Promise.reject(
        new Error(
          "this fleet has no shared browser configured, so the browser tool is not available",
        ),
      );
    return this.inTurn(card, () => this.perform(card, args));
  }

  release(card: number): Promise<OpResult<"browser.release">> {
    return this.inTurn(card, () => this.closeTabs(card));
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

  private async perform(card: number, args: BrowserArgs): Promise<Outcome> {
    if (args.action === "close") return plain(await this.closeOwn(card));
    const cdp = await this.connection();
    if (args.action === "open")
      return this.guarded(card, this.open(cdp, card, checkedUrl(args.url)).then(plain));
    const page = await this.pageOf(cdp, card);
    return this.guarded(card, this.onPage(page, card, args));
  }

  private async closeOwn(card: number): Promise<string> {
    const { closed, note } = await this.closeTabs(card);
    if (note !== null)
      throw new Error(
        `Your tab was not closed and stays open. ${note} Call close again when the browser answers.`,
      );
    return closed > 0 ? "Closed your tab." : "You had no tab open.";
  }

  private async onPage(page: Page, card: number, args: BrowserArgs): Promise<Outcome> {
    if (args.action === "login") return this.signIn(page, card, args.site);
    await this.known(card, page);
    return this.pageAction(page, args, [...(this.hidden.get(card) ?? [])]);
  }

  private hide(card: number, values: readonly string[]): void {
    const known = this.hidden.get(card) ?? new Set<string>();
    for (const value of values) known.add(value);
    this.hidden.set(card, known);
  }

  private async known(card: number, page: Page, opening: readonly string[] = []): Promise<void> {
    if (this.hidden.has(card)) return;
    const logins = this.config?.logins;
    this.hide(card, logins === undefined ? [] : await this.recalled(logins, page, opening));
  }

  private async recalled(
    logins: LoginsConfig,
    page: Page,
    opening: readonly string[],
  ): Promise<string[]> {
    const { host } = await documentOf(page);
    try {
      return await valuesCovering(logins, this.hosts, [host, ...opening]);
    } catch (error) {
      throw new Error(
        `this tab outlived a cardd restart, and the Logins project could not be read to learn which values on it to hide, so nothing was done: ${reason(error)}. Try again when the vault answers`,
        { cause: error },
      );
    }
  }

  private async signIn(page: Page, card: number, site: string | undefined): Promise<Outcome> {
    const logins = this.config?.logins;
    const hide = (values: readonly string[]): void => {
      this.hide(card, values);
    };
    const done = await login({ db: this.db, hosts: this.hosts, logins, card, page, hide }, site);
    return { result: { text: done.text }, notify: done.notify };
  }

  private guarded(card: number, work: Promise<Outcome>): Promise<Outcome> {
    const secrets = (): string[] => [...(this.hidden.get(card) ?? [])];
    return work.then(
      (done) => ({
        notify: done.notify,
        result: { ...done.result, text: cut(scrubbed(done.result.text, secrets())) },
      }),
      (error: unknown) => {
        throw new Error(scrubbed(reason(error), secrets()));
      },
    );
  }

  private async pageAction(
    page: Page,
    args: BrowserArgs,
    secrets: readonly string[],
  ): Promise<Outcome> {
    switch (args.action) {
      case "read":
        return plain(await readPage(page, args));
      case "click":
        return plain(await clickPage(page, args));
      case "type":
        return plain(await typeText(page, args));
      case "press":
        return plain(await pressKey(page, args.key));
      case "eval":
        return plain(await runExpression(page, args.expression, secrets));
      case "screenshot":
        return { result: await screenshot(page, args.fullPage === true, secrets), notify: [] };
      case "login":
      case "open":
      case "close":
        throw new Error(`${args.action} is not a page action`);
    }
  }

  private connection(): Promise<Cdp> {
    const config = this.config;
    if (config === undefined) return Promise.reject(new Error("no shared browser is configured"));
    if (this.link === undefined) {
      const link: Promise<Cdp> = Cdp.connect(config.cdp).then(async (cdp) => {
        cdp.onClose(() => {
          if (this.link === link) this.link = undefined;
          this.sessions.clear();
        });
        try {
          await this.watch(cdp);
          await this.sweep(cdp);
        } catch (error) {
          cdp.close();
          throw error;
        }
        return cdp;
      });
      this.link = link;
      link.catch(() => {
        if (this.link === link) this.link = undefined;
      });
    }
    return this.link.catch((error: unknown) => {
      throw new Error(`the shared browser is unreachable: ${reason(error)}`, { cause: error });
    });
  }

  private async watch(cdp: Cdp): Promise<void> {
    cdp.listen((event) => {
      try {
        this.onTarget(cdp, event.method, event.params);
      } catch {
        return;
      }
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
  }

  private onTarget(cdp: Cdp, method: string, params: unknown): void {
    if (method === "Target.targetCreated") {
      const { targetInfo } = parseCdp(TargetEventSchema, params, "a new target");
      const opener = targetInfo.openerId;
      if (
        targetInfo.type === "page" &&
        opener !== undefined &&
        openTabs(this.db).some((tab) => tab.target === opener)
      )
        cdp.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => undefined);
    } else if (method === "Target.targetDestroyed") {
      const { targetId } = parseCdp(DestroyedSchema, params, "a closed target");
      this.closed(targetId);
    }
  }

  private retire(tabs: readonly Tab[]): void {
    for (const tab of tabs) this.retired.add(tab.target);
  }

  private closed(target: string): void {
    markClosed(this.db, target);
    this.sessions.delete(target);
    this.retired.delete(target);
  }

  private stale(tab: Tab): boolean {
    if (this.retired.has(tab.target)) return true;
    const began = attemptStartedAt(this.db, tab.card);
    return began !== undefined && tab.openedAt < began;
  }

  private async discard(cdp: Cdp, tab: Tab): Promise<void> {
    try {
      await cdp.send("Target.closeTarget", { targetId: tab.target });
    } catch (error) {
      if (!isGone(error)) return;
    }
    this.closed(tab.target);
  }

  private async current(cdp: Cdp, card: number): Promise<Tab | undefined> {
    for (const tab of tabsOf(this.db, card)) {
      if (!this.stale(tab)) return tab;
      await this.discard(cdp, tab);
    }
    return undefined;
  }

  private async sweep(cdp: Cdp): Promise<void> {
    const listed = parseCdp(TargetsSchema, await cdp.send("Target.getTargets"), "the target list");
    const alive = new Set(listed.targetInfos.map((info) => info.targetId));
    for (const tab of openTabs(this.db)) {
      if (!alive.has(tab.target)) this.closed(tab.target);
      else if (cardEnded(this.db, tab.card) || this.stale(tab)) await this.discard(cdp, tab);
    }
  }

  private async open(cdp: Cdp, card: number, url: string): Promise<string> {
    const own = (await this.current(cdp, card)) ?? (await this.create(cdp, card));
    let page: Page;
    try {
      page = await this.attach(cdp, own);
    } catch (error) {
      if (!isGone(error)) throw error;
      this.closed(own.target);
      page = await this.attach(cdp, await this.create(cdp, card));
    }
    await this.known(card, page, [new URL(url).hostname.toLowerCase()]);
    return `Opened ${await navigate(page, url)} in your tab ${labelOf(this.db, card)}.`;
  }

  private async create(cdp: Cdp, card: number): Promise<Tab> {
    const { targetId } = parseCdp(
      CreatedSchema,
      await cdp.send("Target.createTarget", { url: "about:blank" }),
      "a new tab",
    );
    const tab = { target: targetId, card, label: labelOf(this.db, card), openedAt: Date.now() };
    recordTab(this.db, tab);
    if (!this.hidden.has(card)) this.hidden.set(card, new Set());
    return tab;
  }

  private async attach(cdp: Cdp, tab: Tab): Promise<Page> {
    const known = this.sessions.get(tab.target);
    if (known !== undefined) return { cdp, session: known };
    const { sessionId } = parseCdp(
      AttachedSchema,
      await cdp.send("Target.attachToTarget", { targetId: tab.target, flatten: true }),
      "an attached tab",
    );
    const page = { cdp, session: sessionId };
    await cdp.send("Page.enable", {}, { sessionId });
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId });
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: initScript(tab.label), runImmediately: true },
      { sessionId },
    );
    this.sessions.set(tab.target, sessionId);
    return page;
  }

  private async pageOf(cdp: Cdp, card: number): Promise<Page> {
    const own = await this.current(cdp, card);
    if (own === undefined)
      throw new Error("you have no tab yet: call browser with action open first");
    try {
      return await this.attach(cdp, own);
    } catch (error) {
      if (!isGone(error)) throw error;
      this.closed(own.target);
      throw new Error("your tab was closed: call browser with action open again", { cause: error });
    }
  }

  private async closeTabs(card: number, retry = true): Promise<OpResult<"browser.release">> {
    const tabs = tabsOf(this.db, card);
    if (tabs.length === 0) return { closed: 0, note: null };
    let cdp: Cdp;
    try {
      cdp = await this.connection();
    } catch (error) {
      this.retire(tabs);
      return {
        closed: 0,
        note: `${reason(error)}. ${plural(tabs.length)} of c-${String(card)} stay open: cardd closes them when the browser answers again.`,
      };
    }
    let closed = 0;
    const stuck: string[] = [];
    for (const tab of tabs) {
      try {
        await cdp.send("Target.closeTarget", { targetId: tab.target });
      } catch (error) {
        if (!cdp.open && retry) return this.closeTabs(card, false);
        if (!isGone(error)) {
          stuck.push(reason(error));
          this.retire([tab]);
          continue;
        }
      }
      this.closed(tab.target);
      this.hidden.delete(card);
      closed += 1;
    }
    const note =
      stuck[0] === undefined ? null : `${plural(stuck.length)} could not be closed: ${stuck[0]}`;
    return { closed, note };
  }
}
