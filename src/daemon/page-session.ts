import { CdpClient } from "./cdp.js";
import type { Lane } from "./lane.js";

export class PageSession {
  private readonly cdp: CdpClient;
  private readonly sessionId: string;

  private constructor(cdp: CdpClient, sessionId: string) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  static async open(lane: Lane): Promise<PageSession> {
    await lane.start();
    const tabs = await lane.tabs();
    const target = tabs.find((tab) => tab.id === lane.activeTarget) ?? tabs[0];
    if (!target) throw new Error("the lane has no open page");
    const cdp = await CdpClient.connect(await lane.browserWsUrl());
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.id,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("DOM.enable", {}, sessionId);
    return new PageSession(cdp, sessionId);
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string } }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    );
    if (response.exceptionDetails) throw new Error(`page script failed: ${response.exceptionDetails.text}`);
    return response.result.value as T;
  }

  close(): void {
    this.cdp.close();
  }
}
