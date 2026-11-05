import { fileURLToPath } from "node:url";
import type { Card } from "@fleet/protocol";
import { axiAct, axiArgs, axiShot, type Access } from "./browser-axi.ts";
import { Cardd, type Session } from "./cardd.ts";
import { StandInChrome, TcpProxy } from "./chrome.ts";
import type { FakeVault } from "./fake-vault.ts";
import { begin, newCard } from "./fleet.ts";
import { Harness, type Pi, type Turn } from "./harness.ts";
import { parseRecord, type JsonRecord } from "./json.ts";
import { TestSite } from "./site.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

export interface RawWorker {
  readonly card: Card;
  readonly token: string;
  readonly session: Session;
  readonly access: Access;
  readonly act: (args: Record<string, unknown>) => Promise<string>;
  readonly shoot: (fullPage?: boolean) => Promise<string>;
}

export function rawWorker(card: Card, token: string, session: Session, url: string): RawWorker {
  const access = { url, token };
  return {
    card,
    token,
    session,
    access,
    act: (args) => axiAct(access, args),
    shoot: (fullPage = false) => axiShot(access, fullPage),
  };
}

export const RULES =
  "MAP *.example.test 127.0.0.1, MAP *.nothing.test 127.0.0.1, MAP *.evil.test 127.0.0.1";

export interface LabOptions {
  readonly vault?: FakeVault;
  readonly rules?: string;
  readonly proxied?: boolean;
  readonly isolated?: boolean;
  readonly logins?: Record<string, unknown>;
}

export interface Crew {
  readonly card: Card;
  readonly h: Harness;
  readonly pi: Pi;
}

export class BrowserLab {
  readonly chrome: StandInChrome;
  readonly proxy: TcpProxy | undefined;
  readonly site: TestSite;
  readonly cardd: Cardd;
  readonly main: Session;
  readonly mainToken: string;
  private readonly harnesses: Harness[] = [];
  private readonly sessions: Session[] = [];

  private constructor(
    chrome: StandInChrome,
    proxy: TcpProxy | undefined,
    site: TestSite,
    cardd: Cardd,
    main: Session,
    mainToken: string,
  ) {
    this.chrome = chrome;
    this.proxy = proxy;
    this.site = site;
    this.cardd = cardd;
    this.main = main;
    this.mainToken = mainToken;
  }

  static async start(options: LabOptions = {}): Promise<BrowserLab> {
    const { vault, isolated } = options;
    const chrome = await StandInChrome.start(options.rules ?? RULES, undefined, isolated);
    const proxy = options.proxied === true ? await TcpProxy.start(chrome.port) : undefined;
    const endpoint = proxy?.endpoint ?? chrome.endpoint;
    const site = await TestSite.start();
    const config =
      vault === undefined
        ? JSON.stringify({ maverick: { cdp: endpoint } })
        : vault.config("maverick", endpoint, options.logins);
    const cardd = await Cardd.start(vault?.env ?? {}, ["--browser", config]);
    cardd.addProject("web", { maverick: "/clones/web" }, "acme/web");
    const mainToken = cardd.addLane("main");
    const main = await cardd.connect(mainToken);
    return new BrowserLab(chrome, proxy, site, cardd, main, mainToken);
  }

  async crew(title: string): Promise<Crew> {
    const h = await Harness.start();
    this.harnesses.push(h);
    const card = await newCard(this.main, title);
    const token = await begin(this.main, card, "browse");
    const env = { FLEET_URL: this.cardd.url, FLEET_TOKEN: token, FLEET_ROLE: "worker" };
    const pi = h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION], [], true);
    return { card, h, pi };
  }

  async worker(title: string): Promise<RawWorker> {
    const card = await newCard(this.main, title);
    const token = await begin(this.main, card, "browse");
    return this.reconnect({ card, token });
  }

  async reconnect({ card, token }: { card: Card; token: string }): Promise<RawWorker> {
    const session = await this.cardd.connect(token);
    this.sessions.push(session);
    return rawWorker(card, token, session, this.cardd.url);
  }

  async stop(): Promise<void> {
    const stopped = await Promise.allSettled([
      this.main.close(),
      ...this.sessions.splice(0).map((session) => session.close()),
      ...this.harnesses.splice(0).map((h) => h.stop()),
      this.cardd.stop(),
      this.proxy?.stop(),
      this.chrome.stop(),
      this.site.stop(),
    ]);
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
  }
}

function said(text: string): string {
  const first = text.split("\n")[0] ?? "";
  try {
    const record = parseRecord(first);
    const value = record["error"] ?? record["result"];
    return typeof value === "string" ? value : text;
  } catch {
    return text;
  }
}

export const results = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => said(turn.text));

export const recordsOf = (turns: Turn[]): JsonRecord[] =>
  turns
    .filter((turn) => turn.role === "toolResult")
    .flatMap((turn) => {
      try {
        return [parseRecord(turn.text.split("\n")[0] ?? "")];
      } catch {
        return [];
      }
    });

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

export function browserStep(args: Record<string, string | boolean>): {
  tool: string;
  args: { command: string };
} {
  const command = `browser-axi ${axiArgs(args).map(quote).join(" ")}`;
  return { tool: "bash", args: { command } };
}

export function browse(h: Harness, args: Record<string, string | boolean>): void {
  h.onModel(() => browserStep(args));
}
