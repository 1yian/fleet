import type { DatabaseSync } from "node:sqlite";
import { Cdp, parseCdp, type BrowserArgs, type OpResult } from "@fleet/protocol";
import Type from "typebox";
import type { BrowserConfig } from "./browser-config.ts";
import { initScript } from "./browser-init.ts";
import { login, scrubbed } from "./browser-login.ts";
import {
  checkedUrl,
  clickPage,
  navigate,
  pressKey,
  readPage,
  runExpression,
  screenshot,
  typeText,
  type Page,
} from "./browser-page.ts";
import {
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
const isGone = (error: unknown): boolean => reason(error).includes("No target with given id");
const plural = (count: number): string => `${String(count)} tab${count === 1 ? "" : "s"}`;
const plain = (text: string): Outcome => ({ result: { text }, notify: [] });

export class Browser {
  private link: Promise<Cdp> | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly hidden = new Map<number, Set<string>>();
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
    if (args.action === "close") {
      const { closed, note } = await this.closeTabs(card);
      const said = closed > 0 ? "Closed your tab." : "You had no tab open.";
      return plain(note === null ? said : `${said} ${note}`);
    }
    const cdp = await this.connection();
    if (args.action === "open")
      return this.guarded(card, this.open(cdp, card, checkedUrl(args.url)).then(plain));
    const page = await this.pageOf(cdp, card);
    return this.guarded(
      card,
      args.action === "login" ? this.signIn(page, card, args) : this.pageAction(page, args),
    );
  }

  private async signIn(page: Page, card: number, args: BrowserArgs): Promise<Outcome> {
    const logins = this.config?.logins;
    const done = await login({ db: this.db, hosts: this.hosts, logins, card, page }, args.site);
    const known = this.hidden.get(card) ?? new Set<string>();
    for (const value of done.hidden) known.add(value);
    this.hidden.set(card, known);
    return { result: { text: done.text }, notify: done.notify };
  }

  private guarded(card: number, work: Promise<Outcome>): Promise<Outcome> {
    const secrets = (): string[] => [...(this.hidden.get(card) ?? [])];
    return work.then(
      (done) => ({
        notify: done.notify,
        result: { ...done.result, text: scrubbed(done.result.text, secrets()) },
      }),
      (error: unknown) => {
        throw new Error(scrubbed(reason(error), secrets()));
      },
    );
  }

  private async pageAction(page: Page, args: BrowserArgs): Promise<Outcome> {
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
        return plain(await runExpression(page, args.expression));
      case "screenshot":
        return { result: await screenshot(page, args.fullPage === true), notify: [] };
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
      markClosed(this.db, targetId);
      this.sessions.delete(targetId);
    }
  }

  private async sweep(cdp: Cdp): Promise<void> {
    const listed = parseCdp(TargetsSchema, await cdp.send("Target.getTargets"), "the target list");
    const alive = new Set(listed.targetInfos.map((info) => info.targetId));
    for (const tab of openTabs(this.db)) {
      if (!alive.has(tab.target)) markClosed(this.db, tab.target);
      else if (cardEnded(this.db, tab.card))
        await cdp.send("Target.closeTarget", { targetId: tab.target }).then(
          () => {
            markClosed(this.db, tab.target);
          },
          () => undefined,
        );
    }
  }

  private async open(cdp: Cdp, card: number, url: string): Promise<string> {
    const own = tabsOf(this.db, card)[0] ?? (await this.create(cdp, card));
    let page: Page;
    try {
      page = await this.attach(cdp, own);
    } catch (error) {
      if (!isGone(error)) throw error;
      markClosed(this.db, own.target);
      page = await this.attach(cdp, await this.create(cdp, card));
    }
    return `Opened ${await navigate(page, url)} in your tab ${labelOf(this.db, card)}.`;
  }

  private async create(cdp: Cdp, card: number): Promise<Tab> {
    const { targetId } = parseCdp(
      CreatedSchema,
      await cdp.send("Target.createTarget", { url: "about:blank" }),
      "a new tab",
    );
    const tab = { target: targetId, card, label: labelOf(this.db, card) };
    recordTab(this.db, tab);
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
    const own = tabsOf(this.db, card)[0];
    if (own === undefined)
      throw new Error("you have no tab yet: call browser with action open first");
    try {
      return await this.attach(cdp, own);
    } catch (error) {
      if (!isGone(error)) throw error;
      markClosed(this.db, own.target);
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
          continue;
        }
      }
      markClosed(this.db, tab.target);
      this.sessions.delete(tab.target);
      this.hidden.delete(card);
      closed += 1;
    }
    const note =
      stuck[0] === undefined ? null : `${plural(stuck.length)} could not be closed: ${stuck[0]}`;
    return { closed, note };
  }
}
