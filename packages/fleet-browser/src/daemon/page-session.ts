import type { DirectLogin } from "../shared/direct-login.js";
import { CdpClient, CdpError } from "./cdp.js";
import type { Lane } from "./lane.js";

export interface SubmissionGuard {
  submitted(): boolean;
  violated(): boolean;
}

export interface DirectPlan {
  action: string;
  userName: string | null;
  passName: string;
}

export class ContainmentError extends Error {}

const REMOVAL_POLLS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

export class PageSession {
  private readonly cdp: CdpClient;
  private readonly sessionId: string;
  private readonly lane: Lane;
  readonly targetId: string;

  private constructor(cdp: CdpClient, sessionId: string, targetId: string, lane: Lane) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.lane = lane;
  }

  static async open(lane: Lane, target?: string): Promise<PageSession> {
    await lane.start();
    const page = await lane.pageFor(target);
    lane.activate(page.id);
    return PageSession.attach(lane, await CdpClient.connect(await lane.browserWsUrl()), page.id);
  }

  static async openPrivate(lane: Lane): Promise<PageSession> {
    await lane.start();
    const cdp = await CdpClient.connect(await lane.browserWsUrl());
    let targetId: string;
    try {
      targetId = await lane.createPrivateTarget(cdp);
    } catch (error) {
      cdp.close();
      if (!(error instanceof CdpError)) throw new ContainmentError("sign-in tab creation was not confirmed");
      throw error;
    }
    let session: PageSession;
    try {
      session = await PageSession.attach(lane, cdp, targetId);
    } catch (error) {
      await PageSession.sweep(lane, cdp, targetId);
      throw error;
    }
    try {
      await session.send("Network.enable");
      await session.send("Network.setBypassServiceWorker", { bypass: true });
    } catch (error) {
      await session.discard();
      throw error;
    }
    return session;
  }

  private static async attach(lane: Lane, cdp: CdpClient, targetId: string): Promise<PageSession> {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("DOM.enable", {}, sessionId);
    return new PageSession(cdp, sessionId, targetId, lane);
  }

  private static async sweep(lane: Lane, cdp: CdpClient, targetId: string): Promise<void> {
    let closer = cdp;
    try {
      if (cdp.closed) closer = await CdpClient.connect(await lane.browserWsUrl());
      await closer.send("Target.closeTarget", { targetId }).catch(() => undefined);
      let present = true;
      for (let i = 0; i < REMOVAL_POLLS && present; i += 1) {
        present = await lane.hasTarget([targetId]);
        if (present) await sleep(100);
      }
      if (present) throw new Error("private target was not removed");
    } catch {
      throw new ContainmentError("the sign-in tab could not be verified closed");
    } finally {
      if (closer !== cdp) closer.close();
      cdp.close();
    }
  }

  async confine(plan: DirectPlan, delivery: DirectLogin): Promise<SubmissionGuard> {
    const {
      frameTree: {
        frame: { id: mainFrameId },
      },
    } = await this.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const { origin, password, username } = delivery;
    const expectedAction = withoutHash(new URL(plan.action));
    let violated = false;
    let transmitted = false;
    let continued = false;
    let networkId: string | undefined;
    let status: number | undefined;
    let responded = false;
    let navigated = false;
    let loaded = false;
    const own = (sessionId: string | undefined): boolean => sessionId === this.sessionId;
    this.cdp.on("Network.responseReceived", (params, sessionId) => {
      if (!own(sessionId) || networkId === undefined || params.requestId !== networkId) return;
      status = (params.response as { status: number }).status;
      responded = true;
    });
    this.cdp.on("Page.frameNavigated", (params, sessionId) => {
      const frame = params.frame as { id: string; parentId?: string };
      if (own(sessionId) && responded && frame.id === mainFrameId && !frame.parentId) navigated = true;
    });
    this.cdp.on("Page.loadEventFired", (_params, sessionId) => {
      if (own(sessionId) && navigated) loaded = true;
    });
    this.cdp.on("Fetch.requestPaused", (params, sessionId) => {
      if (!own(sessionId)) return;
      const {
        requestId,
        request,
        resourceType,
        frameId,
        networkId: paused,
      } = params as unknown as {
        requestId: string;
        request: { url: string; method: string; hasPostData?: boolean; postData?: string };
        resourceType: string;
        frameId: string;
        networkId?: string;
      };
      let url: URL | null = null;
      try {
        url = new URL(request.url);
      } catch {
        url = null;
      }
      const secure = url?.protocol === "https:";
      const same = secure && url?.origin === origin;
      const carriesBody = (request.method !== "GET" && request.method !== "HEAD") || !!request.hasPostData;
      const bodyKnown = request.postData !== undefined;
      const entries = bodyKnown ? [...new URLSearchParams(request.postData)] : [];
      const has = (name: string, value: string): boolean =>
        entries.some(([key, entry]) => key === name && entry === value);
      const inUrl = url ? [...url.searchParams.values()].includes(password) : false;
      const carries = inUrl || entries.some(([, entry]) => entry === password);
      const submission =
        !transmitted &&
        url !== null &&
        withoutHash(url) === expectedAction &&
        resourceType === "Document" &&
        frameId === mainFrameId &&
        request.method === "POST" &&
        paused !== undefined &&
        !inUrl &&
        has(plan.passName, password) &&
        (username === undefined || (plan.userName !== null && has(plan.userName, username)));
      const allowed = secure && (!carriesBody || (same && bodyKnown)) && (!carries || submission);
      if (!allowed) {
        violated = true;
        void this.cdp
          .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, this.sessionId)
          .catch(() => undefined);
        return;
      }
      if (submission) {
        transmitted = true;
        networkId = paused;
      }
      void this.cdp
        .send("Fetch.continueRequest", { requestId }, this.sessionId)
        .then(() => {
          if (submission) continued = true;
        })
        .catch(() => {
          violated = true;
        });
    });
    await this.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    return {
      submitted: () => continued && responded && navigated && loaded && status !== undefined && status < 400,
      violated: () => violated,
    };
  }

  async discard(): Promise<void> {
    await PageSession.sweep(this.lane, this.cdp, this.targetId);
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
