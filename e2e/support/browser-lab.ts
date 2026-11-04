import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BROWSER_OPS, check, type Card, type OpResult } from "@fleet/protocol";
import { Cardd, type Session } from "./cardd.ts";
import { StandInChrome, TcpProxy } from "./chrome.ts";
import type { FakeVault } from "./fake-vault.ts";
import { begin, newCard } from "./fleet.ts";
import { Harness, type Pi, type Turn } from "./harness.ts";
import { isRecord, parseRecord } from "./json.ts";
import { TestSite } from "./site.ts";

const EXTENSION = fileURLToPath(new URL("../../packages/extension/src/index.ts", import.meta.url));

export interface RawWorker {
  readonly card: Card;
  readonly token: string;
  readonly session: Session;
  readonly act: (args: Record<string, unknown>) => Promise<string>;
  readonly shoot: (fullPage?: boolean) => Promise<string>;
}

function rawWorker(card: Card, token: string, session: Session): RawWorker {
  const call = async (args: Record<string, unknown>): Promise<OpResult<"browser">> =>
    check(BROWSER_OPS.browser.result, await session.call("browser", args));
  return {
    card,
    token,
    session,
    act: async (args) => (await call(args)).text,
    shoot: async (fullPage = false) => {
      const image = (await call({ action: "screenshot", fullPage })).image;
      if (image === undefined) throw new Error("the screenshot came back without a picture");
      return image.data;
    },
  };
}

const RULES =
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
        ? JSON.stringify({ cdp: endpoint })
        : vault.config(endpoint, options.logins);
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
    const pi = h.startPi(`c-${String(card.id)}-a1`, env, [EXTENSION]);
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
    return rawWorker(card, token, session);
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

export const results = (turns: Turn[]): string[] =>
  turns.filter((turn) => turn.role === "toolResult").map((turn) => turn.text);

export function browse(h: Harness, args: Record<string, string | boolean>): void {
  h.onModel(() => ({ tool: "browser", args }));
}

export async function toolImages(h: Harness): Promise<string[]> {
  const file = (await h.waitFor((e) => e["type"] === "session", "session start"))["file"];
  const lines = readFileSync(String(file), "utf8").split("\n").filter(Boolean).map(parseRecord);
  return lines.flatMap((line) => {
    const message = isRecord(line["message"]) ? line["message"] : {};
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    if (message["role"] !== "toolResult") return [];
    return content
      .filter(isRecord)
      .flatMap((block) => (block["type"] === "image" ? [String(block["mimeType"])] : []));
  });
}
