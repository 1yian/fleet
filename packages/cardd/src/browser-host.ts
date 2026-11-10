import type { DatabaseSync } from "node:sqlite";
import {
  checkedUrl,
  parseCdp,
  readSelection,
  type BrowserArgs,
  type Cdp,
  type OpResult,
} from "@fleet/protocol";
import { dial, type Dial } from "@fleet/protocol/tunnel";
import Type from "typebox";
import type { HostBrowserConfig } from "./browser-config.ts";
import { copyAnswer } from "./browser-copy.ts";
import { Entered } from "./browser-entered.ts";
import { holdsFilled, holdsLogin } from "./browser-fill.ts";
import { scrubbed } from "./browser-hidden.ts";
import { initScript } from "./browser-init.ts";
import { PASSWORD_INIT, PASSWORD_WORLD } from "./browser-password.ts";
import { listTabs, type Listing } from "./browser-listing.ts";
import { signIn } from "./browser-login.ts";
import { atPage, guarded, plain, type Outcome } from "./browser-outcome.ts";
import {
  clickPage,
  documentOf,
  navigate,
  pressKey,
  readPage,
  reloadPage,
  runExpression,
  travel,
  typeText,
  type Page,
} from "./browser-page.ts";
import {
  COPY,
  EVAL,
  KEPT,
  MARKUP_ENTERED,
  NO_TAB,
  PICTURE,
  RESTARTED,
  TAB_CLOSED,
  type Refusal,
} from "./browser-refusals.ts";
import { screenshot } from "./browser-shot.ts";
import {
  DestroyedSchema,
  hiderOf,
  isGone,
  reason,
  TargetEventSchema,
  targetsOf,
} from "./browser-targets.ts";
import { Vault } from "./browser-vault.ts";
import { closeTargets, openWindow, raiseWindow, unreachable } from "./browser-window.ts";
import {
  attemptStartedAt,
  labelOf,
  markClosed,
  mustRelease,
  openTabs,
  recordTab,
  retiredIn,
  retiredOf,
  tabsOf,
  type Tab,
} from "./browser-store.ts";

const AttachedSchema = Type.Object({ sessionId: Type.String() });

const TOUCH_BACKOFF_MS = 5_000;

type Act = (page: Page, target: string, args: BrowserArgs) => Promise<Outcome>;

const notAPageAction = (args: BrowserArgs): Promise<Outcome> =>
  Promise.reject(new Error(`${args.action} is not a page action`));

export class HostBrowser {
  private link: Promise<Cdp> | undefined;
  private failedAt = 0;
  private readonly sessions = new Map<string, string>();
  private readonly trusted = new Set<string>();
  private readonly entered = new Entered();
  private readonly filled = new Map<string, { loader: string; fields: readonly string[] }>();
  private readonly db: DatabaseSync;
  private readonly host: string;
  private readonly config: HostBrowserConfig;
  private readonly dial: Dial;
  private readonly vault: Vault;

  constructor(db: DatabaseSync, host: string, config: HostBrowserConfig, via: readonly string[]) {
    this.db = db;
    this.host = host;
    this.config = config;
    this.dial = dial(via, config.cdp);
    this.vault = new Vault(config.logins, host, via);
    for (const tab of openTabs(db, host)) this.entered.mark(tab.target, true);
  }

  hasTab(card: number): boolean {
    return tabsOf(this.db, card, this.host).some((tab) => !this.stale(tab));
  }

  hider(captain: boolean): (text: string) => string {
    return hiderOf(this.vault, captain);
  }

  async listing(tabs: readonly Tab[]): Promise<Listing & { problem: string | null }> {
    try {
      const listed = listTabs(
        this.host,
        this.connection(),
        (cdp, tab) => this.attach(cdp, tab),
        tabs,
      );
      return { ...(await listed), problem: null };
    } catch (error) {
      return { targets: new Map(), standing: new Map(), problem: reason(error) };
    }
  }

  async raise(card: number): Promise<void> {
    const cdp = await this.connection();
    const tab = await this.current(cdp, card);
    if (tab !== undefined) await raiseWindow(cdp, tab.target);
  }

  assumeEntered(tabs: readonly Tab[]): void {
    for (const tab of tabs) this.entered.mark(tab.target, true);
  }

  async enter(card: number, target: string): Promise<void> {
    this.entered.mark(target);
    await this.inspect(card, target);
  }

  async held(card: number, target: string): Promise<boolean> {
    return this.entered.has(target) && (await this.inspect(card, target).catch(() => true));
  }

  private async inspect(card: number, target: string): Promise<boolean> {
    const own = await this.pageOf(await this.connection(), card);
    if (own.target !== target) throw new Error("that tab is not open");
    return this.entered.holds(own.page, target);
  }

  frame(card: number, target: string): Promise<OpResult<"browser.frame">> {
    return this.guarded(this.framed(card, target)).then(
      ({ result }) => ({ image: result.image ?? null, note: null }),
      (error: unknown) => ({ image: null, note: reason(error) }),
    );
  }

  private async ownPage(
    card: number,
    target: string,
    action: "read" | "screenshot",
  ): Promise<Page> {
    await this.vault.ready();
    const own = await this.pageOf(await this.connection(), card);
    if (own.target !== target) throw new Error("that tab is not open");
    if (this.mayShowCode(target, action)) throw new Error(RESTARTED);
    return own.page;
  }

  private async framed(card: number, target: string): Promise<Outcome> {
    return this.pictureOf(await this.ownPage(card, target, "screenshot"), target, false, true);
  }

  copy(card: number, target: string): Promise<OpResult<"browser.copy">> {
    return copyAnswer(this.copied(card, target), this.vault.values);
  }

  private async copied(card: number, target: string): Promise<string> {
    const page = await this.ownPage(card, target, "read");
    await this.refuseWhileFilled(page, target, COPY);
    return scrubbed(await readSelection(page.cdp, page.session), this.vault.values);
  }

  private async pictureOf(
    page: Page,
    target: string,
    fullPage: boolean,
    jpeg: boolean,
  ): Promise<Outcome> {
    await this.refuseWhileFilled(page, target, PICTURE);
    return { result: await screenshot(page, fullPage, this.vault.values, jpeg), notify: [] };
  }

  touch(): void {
    if (this.link === undefined && Date.now() - this.failedAt < TOUCH_BACKOFF_MS) return;
    this.connection().catch(() => undefined);
  }

  async perform(card: number, args: BrowserArgs): Promise<Outcome> {
    if (args.action === "open") {
      const url = checkedUrl(args.url);
      await this.vault.beforeOpening(new URL(url).hostname.toLowerCase());
      const cdp = await this.connection();
      return this.guarded(this.open(cdp, card, url).then(plain));
    }
    if (args.action !== "login") await this.vault.ready();
    const { page, target } = await this.pageOf(await this.connection(), card);
    if (this.mayShowCode(target, args.action)) throw new Error(RESTARTED);
    return this.guarded(
      args.action === "login"
        ? signIn(
            { db: this.db, vault: this.vault, filled: this.filled },
            card,
            page,
            target,
            args.site,
          )
        : this.acts[args.action](page, target, args),
    );
  }

  private mayHoldCode(target: string): boolean {
    return this.config.logins?.totp === true && !this.trusted.has(target);
  }

  private mayShowCode(target: string, action: BrowserArgs["action"]): boolean {
    return ["read", "eval", "screenshot"].includes(action) && this.mayHoldCode(target);
  }

  private async refuseWhileEntered(page: Page, target: string, refusal: string): Promise<void> {
    if (this.entered.has(target) && (await this.entered.holds(page, target).catch(() => true)))
      throw new Error(refusal);
  }

  private async refuseWhileFilled(page: Page, target: string, refusal: Refusal): Promise<void> {
    const mark = this.filled.get(target);
    if (mark !== undefined || !this.trusted.has(target)) {
      const current = mark === undefined ? undefined : (await documentOf(page)).loader;
      const fields = mark !== undefined && current === mark.loader ? mark.fields : undefined;
      const held =
        fields === undefined
          ? await holdsLogin(page, this.vault.values, mark !== undefined)
          : await holdsFilled(page, fields);
      if (held) throw new Error(refusal.stored);
      if (fields !== undefined) this.filled.delete(target);
    }
    await this.refuseWhileEntered(page, target, refusal.entered);
  }

  private guarded(work: Promise<Outcome>): Promise<Outcome> {
    return guarded(work, this.vault.values);
  }

  private readonly acts: Record<BrowserArgs["action"], Act> = {
    back: async (page) => atPage(page, await travel(page, "back")),
    forward: async (page) => atPage(page, await travel(page, "forward")),
    reload: async (page) => atPage(page, await reloadPage(page)),
    read: async (page, target, args) => {
      if (args.html === true) await this.refuseWhileEntered(page, target, MARKUP_ENTERED);
      return atPage(page, await readPage(page, args));
    },
    click: async (page, _, args) => atPage(page, await clickPage(page, args)),
    type: async (page, _, args) => plain(await typeText(page, args)),
    press: async (page, _, args) => plain(await pressKey(page, args.key)),
    eval: async (page, target, args) => {
      await this.refuseWhileFilled(page, target, EVAL);
      return plain(await runExpression(page, args.expression, this.vault.values));
    },
    screenshot: (page, target, args) => this.pictureOf(page, target, args.fullPage === true, false),
    login: (_, __, args) => notAPageAction(args),
    open: (_, __, args) => notAPageAction(args),
    close: (_, __, args) => notAPageAction(args),
  };

  private connection(): Promise<Cdp> {
    if (this.link === undefined) {
      const link: Promise<Cdp> = this.dial.connect().then(async (cdp) => {
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
        this.failedAt = Date.now();
      });
    }
    return this.link.catch((error: unknown) => {
      throw new Error(`the browser on ${this.host} is unreachable: ${reason(error)}`, {
        cause: error,
      });
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
        openTabs(this.db, this.host).some((tab) => tab.target === opener)
      )
        cdp.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => undefined);
    } else if (method === "Target.targetDestroyed") {
      const { targetId } = parseCdp(DestroyedSchema, params, "a closed target");
      this.closed(targetId);
    }
  }

  private retire(tabs: readonly Tab[]): void {
    for (const tab of tabs) this.closed(tab.target);
  }

  private closed(target: string): void {
    markClosed(this.db, target);
    this.sessions.delete(target);
    this.trusted.delete(target);
    this.filled.delete(target);
    this.entered.forget(target);
  }

  private stale(tab: Tab): boolean {
    const began = attemptStartedAt(this.db, tab.card);
    return began !== undefined && tab.openedAt < began;
  }

  private async discard(cdp: Cdp, tab: Tab): Promise<void> {
    await cdp.send("Target.closeTarget", { targetId: tab.target }).catch(() => undefined);
    this.closed(tab.target);
  }

  private async current(cdp: Cdp, card: number): Promise<Tab | undefined> {
    for (const tab of tabsOf(this.db, card, this.host)) {
      if (!this.stale(tab)) return tab;
      await this.discard(cdp, tab);
    }
    return undefined;
  }

  private async alive(cdp: Cdp): Promise<Set<string>> {
    return new Set((await targetsOf(cdp)).keys());
  }

  private async sweep(cdp: Cdp): Promise<void> {
    const alive = await this.alive(cdp);
    const retired = retiredIn(this.db, this.host, alive);
    for (const tab of openTabs(this.db, this.host)) {
      if (!alive.has(tab.target)) this.closed(tab.target);
      else if (mustRelease(this.db, tab.card) || this.stale(tab)) await this.discard(cdp, tab);
    }
    for (const target of retired) {
      await cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
      this.sessions.delete(target);
    }
  }

  private async open(cdp: Cdp, card: number, url: string): Promise<string> {
    let tab = (await this.current(cdp, card)) ?? (await this.create(cdp, card));
    let page: Page;
    try {
      page = await this.attach(cdp, tab);
    } catch (error) {
      if (!isGone(error)) throw error;
      this.closed(tab.target);
      tab = await this.create(cdp, card);
      page = await this.attach(cdp, tab);
    }
    const before = this.trusted.has(tab.target) ? undefined : (await documentOf(page)).loader;
    const where = await navigate(page, url);
    const replaced = before === undefined || (await documentOf(page)).loader !== before;
    if (!replaced && this.mayHoldCode(tab.target)) throw new Error(KEPT);
    if (replaced) this.trusted.add(tab.target);
    return `Opened ${where} in your tab ${labelOf(this.db, card)}.`;
  }

  private async create(cdp: Cdp, card: number): Promise<Tab> {
    const targetId = await openWindow(cdp);
    const tab = {
      host: this.host,
      target: targetId,
      card,
      label: labelOf(this.db, card),
      openedAt: Date.now(),
    };
    recordTab(this.db, tab);
    this.trusted.add(targetId);
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
      { source: PASSWORD_INIT, worldName: PASSWORD_WORLD, runImmediately: true },
      { sessionId },
    );
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: initScript(tab.label), runImmediately: true },
      { sessionId },
    );
    if (this.entered.has(tab.target) && !this.trusted.has(tab.target))
      await this.entered.holds(page, tab.target, "all");
    this.sessions.set(tab.target, sessionId);
    return page;
  }

  private async pageOf(cdp: Cdp, card: number): Promise<{ page: Page; target: string }> {
    const own = await this.current(cdp, card);
    if (own === undefined) throw new Error(NO_TAB);
    try {
      return { page: await this.attach(cdp, own), target: own.target };
    } catch (error) {
      if (!isGone(error)) throw error;
      this.closed(own.target);
      throw new Error(TAB_CLOSED, { cause: error });
    }
  }

  closeTabs(card: number): Promise<OpResult<"browser.release">> {
    this.retire(tabsOf(this.db, card, this.host));
    const targets = retiredOf(this.db, card, this.host);
    if (targets.length === 0) return Promise.resolve({ closed: 0, note: null });
    return this.closeAll(card, targets, true);
  }

  private async closeAll(
    card: number,
    targets: readonly string[],
    retry: boolean,
  ): Promise<OpResult<"browser.release">> {
    let cdp: Cdp;
    try {
      cdp = await this.connection();
    } catch (error) {
      return unreachable(this.host, card, targets.length, error);
    }
    try {
      return await closeTargets(cdp, targets, (target) => {
        this.closed(target);
      });
    } catch (error) {
      if (!cdp.open && retry) return this.closeAll(card, targets, false);
      return unreachable(this.host, card, targets.length, error);
    }
  }
}
