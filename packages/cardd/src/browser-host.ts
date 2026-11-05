import type { DatabaseSync } from "node:sqlite";
import { parseCdp, type BrowserArgs, type Cdp, type OpResult } from "@fleet/protocol";
import { dial, type Dial } from "@fleet/protocol/tunnel";
import Type from "typebox";
import type { HostBrowserConfig } from "./browser-config.ts";
import { holdsFilled, holdsLogin } from "./browser-fill.ts";
import { scrubbed } from "./browser-hidden.ts";
import { initScript } from "./browser-init.ts";
import { login } from "./browser-login.ts";
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
import { CREDENTIAL_SHOWN } from "./browser-scan.ts";
import { screenshot } from "./browser-shot.ts";
import { hiderOf, targetsOf, type Listed } from "./browser-targets.ts";
import { Vault } from "./browser-vault.ts";
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

export interface Outcome {
  readonly result: OpResult<"browser">;
  readonly notify: readonly string[];
  readonly captain?: string;
}

const AttachedSchema = Type.Object({ sessionId: Type.String() });
const CreatedSchema = Type.Object({ targetId: Type.String() });
const TargetEventSchema = Type.Object({
  targetInfo: Type.Object({
    targetId: Type.String(),
    type: Type.String(),
    openerId: Type.Optional(Type.String()),
  }),
});
const DestroyedSchema = Type.Object({ targetId: Type.String() });

const TOUCH_BACKOFF_MS = 5_000;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isGone = (error: unknown): boolean =>
  /no target (with given id|found for targetId)/i.test(reason(error));
export const plural = (count: number): string => `${String(count)} tab${count === 1 ? "" : "s"}`;
const plain = (text: string): Outcome => ({ result: { text }, notify: [] });
const EVAL_REFUSED =
  "nothing was evaluated: a stored credential is in this page's form; click Sign in first, or read the page as text";

export class HostBrowser {
  private link: Promise<Cdp> | undefined;
  private failedAt = 0;
  private readonly sessions = new Map<string, string>();
  private readonly trusted = new Set<string>();
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
  }

  hasTab(card: number): boolean {
    return tabsOf(this.db, card, this.host).some((tab) => !this.stale(tab));
  }

  hider(captain: boolean): (text: string) => string {
    return hiderOf(this.vault, captain);
  }

  async listing(): Promise<{ targets: Map<string, Listed>; problem: string | null }> {
    try {
      return { targets: await targetsOf(await this.connection()), problem: null };
    } catch (error) {
      return { targets: new Map(), problem: reason(error) };
    }
  }

  frame(card: number, target: string): Promise<OpResult<"browser.frame">> {
    return this.guarded(this.framed(card, target)).then(
      ({ result }) => ({ image: result.image ?? null, note: null }),
      (error: unknown) => ({ image: null, note: reason(error) }),
    );
  }

  private async framed(card: number, target: string): Promise<Outcome> {
    await this.vault.ready();
    const own = await this.pageOf(await this.connection(), card);
    if (own.target !== target) throw new Error("that tab is not open");
    if (this.mayShowCode(target, "screenshot")) throw this.restarted();
    return this.pictureOf(own.page, target, false, true);
  }

  private async pictureOf(
    page: Page,
    target: string,
    fullPage: boolean,
    jpeg: boolean,
  ): Promise<Outcome> {
    await this.refuseWhileFilled(page, target, CREDENTIAL_SHOWN);
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
    if (this.mayShowCode(target, args.action)) throw this.restarted();
    return this.guarded(
      args.action === "login"
        ? this.signIn(page, card, target, args.site)
        : this.pageAction(page, target, args, this.vault.values),
    );
  }

  private mayHoldCode(target: string): boolean {
    return this.config.logins?.totp === true && !this.trusted.has(target);
  }

  private mayShowCode(target: string, action: BrowserArgs["action"]): boolean {
    return ["read", "eval", "screenshot"].includes(action) && this.mayHoldCode(target);
  }

  private kept(): Error {
    return new Error(
      "this tab was already open when cardd restarted, and the address you gave did not replace its page (it only changed the part after #, or it was not a page), so a one-time code may still be in it and the tab stays refused: call browser with action open and an address of a different page",
    );
  }

  private restarted(): Error {
    return new Error(
      "this tab was already open when cardd restarted, and it may show a one-time code that cardd can no longer hide, so nothing was returned: call browser with action open to load a fresh page, then try again",
    );
  }

  private async signIn(
    page: Page,
    card: number,
    target: string,
    site: string | undefined,
  ): Promise<Outcome> {
    const mark = (loader: string, fields: readonly string[]): void => {
      const known = this.filled.get(target);
      const kept = known?.loader === loader ? known.fields : [];
      this.filled.set(target, { loader, fields: [...kept, ...fields] });
    };
    const done = await login({ db: this.db, vault: this.vault, card, page, mark }, site);
    return {
      result: { text: done.text },
      notify: done.notify,
      ...(done.captain === undefined ? {} : { captain: done.captain }),
    };
  }

  private async refuseWhileFilled(page: Page, target: string, refusal: string): Promise<void> {
    const mark = this.filled.get(target);
    if (mark === undefined && this.trusted.has(target)) return;
    const current = mark === undefined ? undefined : (await documentOf(page)).loader;
    const fields = mark !== undefined && current === mark.loader ? mark.fields : undefined;
    const held =
      fields === undefined
        ? await holdsLogin(page, this.vault.values, mark !== undefined)
        : await holdsFilled(page, fields);
    if (held) throw new Error(refusal);
    if (fields !== undefined) this.filled.delete(target);
  }

  private guarded(work: Promise<Outcome>): Promise<Outcome> {
    return work.then(
      (done) => ({
        notify: done.notify,
        ...(done.captain === undefined ? {} : { captain: done.captain }),
        result: { ...done.result, text: cut(scrubbed(done.result.text, this.vault.values)) },
      }),
      (error: unknown) => {
        throw new Error(scrubbed(reason(error), this.vault.values));
      },
    );
  }

  private async pageAction(
    page: Page,
    target: string,
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
        await this.refuseWhileFilled(page, target, EVAL_REFUSED);
        return plain(await runExpression(page, args.expression, secrets));
      case "screenshot":
        return this.pictureOf(page, target, args.fullPage === true, false);
      case "login":
      case "open":
      case "close":
        throw new Error(`${args.action} is not a page action`);
    }
  }

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
    if (!replaced && this.mayHoldCode(tab.target)) throw this.kept();
    if (replaced) this.trusted.add(tab.target);
    return `Opened ${where} in your tab ${labelOf(this.db, card)}.`;
  }

  private async create(cdp: Cdp, card: number): Promise<Tab> {
    const { targetId } = parseCdp(
      CreatedSchema,
      await cdp.send("Target.createTarget", { url: "about:blank" }),
      "a new tab",
    );
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
      { source: initScript(tab.label), runImmediately: true },
      { sessionId },
    );
    this.sessions.set(tab.target, sessionId);
    return page;
  }

  private async pageOf(cdp: Cdp, card: number): Promise<{ page: Page; target: string }> {
    const own = await this.current(cdp, card);
    if (own === undefined)
      throw new Error("you have no tab yet: call browser with action open first");
    try {
      return { page: await this.attach(cdp, own), target: own.target };
    } catch (error) {
      if (!isGone(error)) throw error;
      this.closed(own.target);
      throw new Error("your tab was closed: call browser with action open again", { cause: error });
    }
  }

  closeTabs(card: number): Promise<OpResult<"browser.release">> {
    this.retire(tabsOf(this.db, card, this.host));
    const targets = retiredOf(this.db, card, this.host);
    if (targets.length === 0) return Promise.resolve({ closed: 0, note: null });
    return this.closeAll(card, targets, true);
  }

  private unreachable(card: number, count: number, error: unknown): OpResult<"browser.release"> {
    return {
      closed: 0,
      note: `${reason(error)}. ${plural(count)} of c-${String(card)} stay open: cardd closes them when the browser on ${this.host} answers again.`,
    };
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
      return this.unreachable(card, targets.length, error);
    }
    try {
      return await this.closeAlive(cdp, targets);
    } catch (error) {
      if (!cdp.open && retry) return this.closeAll(card, targets, false);
      return this.unreachable(card, targets.length, error);
    }
  }

  private async closeAlive(
    cdp: Cdp,
    targets: readonly string[],
  ): Promise<OpResult<"browser.release">> {
    const alive = await this.alive(cdp);
    let closed = 0;
    const stuck: string[] = [];
    for (const target of targets.filter((each) => alive.has(each))) {
      try {
        await cdp.send("Target.closeTarget", { targetId: target });
        closed += 1;
      } catch (error) {
        if (!cdp.open) throw error;
        if (isGone(error)) closed += 1;
        else stuck.push(reason(error));
      }
      this.closed(target);
    }
    const note =
      stuck[0] === undefined ? null : `${plural(stuck.length)} could not be closed: ${stuck[0]}`;
    return { closed, note };
  }
}
