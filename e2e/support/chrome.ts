import { createServer } from "node:net";
import { Cdp } from "@fleet/protocol";
import { chromium, type Browser } from "playwright";
import { isRecord, optionalString } from "./json.ts";

export interface Target {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly parent: string;
}

export class StandInChrome {
  readonly endpoint: string;
  private readonly browser: Browser;

  private constructor(browser: Browser, endpoint: string) {
    this.browser = browser;
    this.endpoint = endpoint;
  }

  static async start(
    rules = "MAP *.example.test 127.0.0.1",
    extraArgs: readonly string[] = [],
    fixedPort?: number,
  ): Promise<StandInChrome> {
    const port = fixedPort ?? (await freePort());
    const browser = await chromium.launch({
      args: [
        `--remote-debugging-port=${String(port)}`,
        `--host-resolver-rules=${rules}`,
        ...extraArgs,
      ],
    });
    return new StandInChrome(browser, `http://127.0.0.1:${String(port)}`);
  }

  async targets(): Promise<Target[]> {
    const listed: unknown = await (await fetch(`${this.endpoint}/json/list`)).json();
    if (!Array.isArray(listed)) throw new Error("/json/list is not a list");
    return listed.filter(isRecord).map((each) => ({
      id: optionalString(each, "id") ?? "",
      type: optionalString(each, "type") ?? "",
      title: optionalString(each, "title") ?? "",
      url: optionalString(each, "url") ?? "",
      parent: optionalString(each, "parentId") ?? "",
    }));
  }

  async pages(): Promise<Target[]> {
    return (await this.targets()).filter((target) => target.type === "page");
  }

  async open(url: string): Promise<string> {
    const cdp = await Cdp.connect(this.endpoint);
    try {
      const created = await cdp.send("Target.createTarget", { url });
      const target = isRecord(created) ? optionalString(created, "targetId") : undefined;
      if (target === undefined) throw new Error("the browser opened no tab");
      return target;
    } finally {
      cdp.close();
    }
  }

  async closeTab(target: string): Promise<void> {
    const cdp = await Cdp.connect(this.endpoint);
    try {
      await cdp.send("Target.closeTarget", { targetId: target });
    } finally {
      cdp.close();
    }
  }

  async evaluate(target: string, expression: string): Promise<unknown> {
    const cdp = await Cdp.connect(this.endpoint);
    try {
      const sessionId = await attach(cdp, target);
      const done = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        { sessionId },
      );
      const result = isRecord(done) ? done["result"] : undefined;
      return isRecord(result) ? result["value"] : undefined;
    } finally {
      cdp.close();
    }
  }

  async stop(): Promise<void> {
    await this.browser.close();
  }
}

async function attach(cdp: Cdp, target: string): Promise<string> {
  const attached = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
  const sessionId = isRecord(attached) ? optionalString(attached, "sessionId") : undefined;
  if (sessionId === undefined) throw new Error("the tab did not attach");
  return sessionId;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}
