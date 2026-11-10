import { createInterface } from "node:readline";
import { Cdp } from "@fleet/protocol";
import type { Dial } from "@fleet/protocol/tunnel";
import { current, sendBack, through } from "./takeover-host.ts";
import type { LocalChrome } from "./takeover-mac.ts";
import {
  attach,
  blankPage,
  clearOrigin,
  landOn,
  navigate,
  originOf,
  pagesOf,
  readCookies,
  readStorage,
  replaceCookies,
  replaceStorage,
  type Page,
} from "./takeover-page.ts";
import { changes, counts, type Session } from "./takeover-session.ts";

type Outcome = "sent" | "discarded" | "closed";

export interface Parts {
  readonly chrome: LocalChrome;
  readonly held: Session;
  readonly tab: Page;
  readonly via: Dial;
  readonly host: string;
  readonly profile: string;
  readonly tunnelEnded: Promise<string>;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const say = (line: string): void => {
  console.log(line);
};

export class Takeover {
  private readonly parts: Parts;
  private mac: Cdp | undefined;
  private macTab = "";

  constructor(parts: Parts) {
    this.parts = parts;
  }

  private connection(): Cdp {
    if (this.mac === undefined) throw new Error("Chrome is not connected");
    return this.mac;
  }

  private async receive(): Promise<void> {
    const { chrome, held, tab } = this.parts;
    const mac = await Cdp.connect(chrome.endpoint);
    this.mac = mac;
    const [first] = await pagesOf(mac);
    this.macTab = first?.id ?? (await blankPage(mac));
    const sessionId = await attach(mac, this.macTab);
    const refused = await replaceCookies(mac, sessionId, held.urls, held.cookies);
    if (refused.length > 0) say(`warning: Chrome refused these cookies: ${refused.join(", ")}`);
    await landOn(mac, sessionId, held.origin);
    if (held.storage !== undefined) await replaceStorage(mac, sessionId, held.storage);
    const failure = await navigate(mac, sessionId, tab.url);
    if (failure !== undefined) say(`warning: the page did not load: ${failure}`);
  }

  private async collect(): Promise<Session> {
    const mac = this.connection();
    const { held } = this.parts;
    const sessionId = await attach(mac, this.macTab).catch(() => {
      throw new Error("the tab in Chrome is closed: type discard, and take the tab again");
    });
    const cookies = await readCookies(mac, sessionId, held.urls);
    const here = await originOf(mac, sessionId).catch(() => undefined);
    if (here !== held.origin) await landOn(mac, sessionId, held.origin);
    return { ...held, cookies, storage: await readStorage(mac, sessionId) };
  }

  private async back(force: boolean): Promise<boolean> {
    const { held, tab, via, host } = this.parts;
    const now = await through(via, (cdp) => current(cdp, tab, held));
    const moved = changes(held, now);
    if (!force && moved.length > 0) {
      say(
        `Refused: the worker's tab changed while you held it (${moved.join(", ")}). Type back --force to replace it anyway, or discard.`,
      );
      return false;
    }
    const mine = await this.collect();
    const sent = await through(via, (cdp) => sendBack(cdp, tab, mine));
    say(`Sent back to ${host}: ${counts(mine)}. The worker's tab was reloaded.`);
    if (sent.refused.length > 0)
      say(`warning: the host's Chrome refused these cookies: ${sent.refused.join(", ")}`);
    if (!sent.storage)
      say(
        `warning: the worker's tab is not on ${held.origin} any more, so only cookies were replaced.`,
      );
    return true;
  }

  private async command(line: string): Promise<Outcome | undefined> {
    try {
      switch (line) {
        case "back":
        case "back --force":
          return (await this.back(line.endsWith("--force"))) ? "sent" : undefined;
        case "discard":
          return "discarded";
        case "":
          return undefined;
        default:
          say("Type back, back --force, or discard, then Enter.");
          return undefined;
      }
    } catch (error) {
      say(`failed: ${reason(error)}`);
      return undefined;
    }
  }

  private ending(): Promise<Outcome> {
    return new Promise((resolve) => {
      const input = createInterface({ input: process.stdin });
      let queue: Promise<void> = Promise.resolve();
      input.on("line", (line) => {
        queue = queue
          .then(() => this.command(line.trim()))
          .then((done) => {
            if (done !== undefined) resolve(done);
          });
      });
      input.once("close", () => {
        resolve("discarded");
      });
      void this.parts.chrome.exited.then(() => {
        resolve("closed");
      });
      void this.parts.tunnelEnded.then((why) => {
        say(
          `warning: the ssh tunnel ended (${why}). This Chrome cannot reach the site now: type back to send what it holds, or discard.`,
        );
      });
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        process.once(signal, () => {
          resolve("discarded");
        });
    });
  }

  private async scrub(): Promise<void> {
    const mac = this.connection();
    const { held } = this.parts;
    const sessionId = await attach(mac, await blankPage(mac));
    await replaceCookies(mac, sessionId, held.urls, []);
    await clearOrigin(mac, sessionId, held.origin);
    say(`Removed the copied session of ${held.origin} from the Mac profile.`);
  }

  async run(): Promise<void> {
    const { chrome, host, held } = this.parts;
    try {
      await this.receive();
      say(`Chrome is open with ${held.origin} signed in as the worker's tab, through ssh ${host}.`);
      say(
        "When you are done, type back (send this Chrome's session to the worker's tab and reload it), back --force, or discard, then Enter.",
      );
      const outcome = await this.ending();
      if (outcome === "closed")
        say(
          `Chrome was closed, so nothing was sent back. The copied session may still be in ${this.parts.profile}: delete that folder to remove it.`,
        );
      else
        await this.scrub().catch((error: unknown) => {
          say(`warning: could not remove the copied session: ${reason(error)}`);
        });
      if (outcome === "discarded") say("Discarded: the worker's tab was not touched.");
    } finally {
      this.mac?.close();
      await chrome.quit();
    }
  }
}
