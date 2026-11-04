import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { needlesOf } from "./browser-hidden.ts";
import { call, type Page } from "./browser-page.ts";
import { covers, scan, snapshotOf, type Rect, type Scanned } from "./browser-snapshot.ts";

const GROUP = "fleet-cover";
const WORLD = "fleet-cover";
const MAX_HEIGHT = 16_384;

const STYLE = `() => {
  const sheet = "*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: none !important; }";
  const roots = [document];
  for (let at = 0; at < roots.length; at += 1)
    for (const el of roots[at].querySelectorAll("*")) if (el.shadowRoot !== null) roots.push(el.shadowRoot);
  return roots.map((root) => {
    const style = document.createElement("style");
    style.textContent = sheet;
    (root === document ? document.documentElement : root).appendChild(style);
    return style;
  });
}`;

const COVER = `(rects) => {
  const container = document.createElement("div");
  container.setAttribute("data-fleet-cover", "container");
  container.style.cssText = "all: initial !important; display: block !important; position: absolute !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important;";
  document.documentElement.appendChild(container);
  for (const rect of rects) {
    const left = Math.floor(rect.x) - 2;
    const top = Math.floor(rect.y) - 2;
    const width = Math.ceil(rect.x + rect.width) + 2 - left;
    const height = Math.ceil(rect.y + rect.height) + 2 - top;
    const box = document.createElement("div");
    box.setAttribute("data-fleet-cover", "box");
    const place = (x, y) => {
      box.style.cssText = "all: initial !important; display: block !important; position: absolute !important; background: #000 !important; left: " + x + "px !important; top: " + y + "px !important; width: " + width + "px !important; height: " + height + "px !important;";
    };
    place(left, top);
    container.appendChild(box);
    const at = box.getBoundingClientRect();
    place(left + (left - scrollX - at.left), top + (top - scrollY - at.top));
  }
  return container;
}`;

const REMOVE = "function () { for (const node of [].concat(this)) node.remove(); }";

const CoveredSchema = Type.Object({
  result: Type.Object({ objectId: Type.String() }),
  exceptionDetails: Type.Optional(Type.Unknown()),
});
const NodeSchema = Type.Object({
  frame: Type.Object({ id: Type.String(), loaderId: Type.String() }),
  childFrames: Type.Optional(Type.Array(Type.Unknown())),
});
const TreeSchema = Type.Object({ frameTree: NodeSchema });
const WorldSchema = Type.Object({ executionContextId: Type.Integer() });
const AttachedSchema = Type.Object({
  sessionId: Type.String(),
  targetInfo: Type.Object({ type: Type.String() }),
});
const LayoutSchema = Type.Object({
  cssLayoutViewport: Type.Object({ clientWidth: Type.Number() }),
  cssContentSize: Type.Object({ height: Type.Number() }),
});

const refused = (why: string): Error => new Error(`no picture was returned: ${why}`);
const unreachable = (): Error =>
  refused("a frame on the page could not be covered, so a value that it shows could not be hidden");
const unstable = (): Error =>
  refused("the page changed while the picture was taken, so a value might have been shown");

interface Held {
  readonly page: Page;
  readonly objectId: string;
}

interface Target {
  readonly page: Page;
  readonly documents: number;
  readonly remote: number;
}

const exposed = (documents: readonly Scanned[]): boolean =>
  documents.some((doc) => doc.hits.some((hit) => !doc.boxes.some((box) => covers(box, hit))));

const idsOf = (node: unknown): string[] => {
  const { frame, childFrames } = parseCdp(NodeSchema, node, "a frame");
  return [frame.id, ...(childFrames ?? []).flatMap(idsOf)];
};

const signature = (node: unknown): string[] => {
  const { frame, childFrames } = parseCdp(NodeSchema, node, "a frame");
  return [`${frame.id}@${frame.loaderId}`, ...(childFrames ?? []).flatMap(signature)];
};

export class Coverage {
  private readonly root: Page;
  private readonly needles: readonly string[];
  private readonly held: Held[] = [];
  private readonly targets: Target[] = [];
  private readonly frozen: Page[] = [];
  private readonly attached: Page[] = [];
  private readonly children = new Map<string, Page[]>();
  private unlisten: (() => void) | undefined;
  private sized = false;
  private shape = "";

  constructor(root: Page, secrets: readonly string[]) {
    this.root = root;
    this.needles = needlesOf(secrets);
  }

  async begin(fullPage: boolean): Promise<void> {
    this.unlisten = this.root.cdp.listen((event) => {
      if (event.method !== "Target.attachedToTarget" || event.sessionId === undefined) return;
      const attached = parseCdp(AttachedSchema, event.params, "an attached frame");
      if (attached.targetInfo.type !== "iframe") return;
      const found = this.children.get(event.sessionId) ?? [];
      found.push({ cdp: this.root.cdp, session: attached.sessionId });
      this.children.set(event.sessionId, found);
    });
    if (fullPage) await this.expand();
    await this.over(this.root);
    this.shape = await this.shapeOf();
  }

  async verify(): Promise<void> {
    if ((await this.shapeOf()) !== this.shape) throw unstable();
    for (const target of this.targets) {
      const documents = scan(
        await snapshotOf(target.page).catch(() => {
          throw unstable();
        }),
        this.needles,
      );
      const remote = documents.reduce((total, doc) => total + doc.remote, 0);
      if (documents.length !== target.documents || remote !== target.remote) throw unstable();
      if (exposed(documents)) throw unstable();
    }
  }

  async lift(): Promise<void> {
    this.unlisten?.();
    for (const { page, objectId } of this.held.toReversed())
      await call(page, "Runtime.callFunctionOn", { objectId, functionDeclaration: REMOVE }).catch(
        () => undefined,
      );
    for (const page of this.frozen) {
      await call(page, "Animation.setPlaybackRate", { playbackRate: 1 }).catch(() => undefined);
      await call(page, "Emulation.setScriptExecutionDisabled", { value: false }).catch(
        () => undefined,
      );
    }
    const pages = new Map(this.held.map((each) => [each.page.session, each.page]));
    for (const page of pages.values())
      await call(page, "Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
    for (const page of this.attached)
      await call(page, "Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => undefined);
    if (this.sized)
      await call(this.root, "Emulation.clearDeviceMetricsOverride").catch(() => undefined);
  }

  private async expand(): Promise<void> {
    const layout = parseCdp(
      LayoutSchema,
      await call(this.root, "Page.getLayoutMetrics"),
      "the page's size",
    );
    this.sized = true;
    await call(this.root, "Emulation.setDeviceMetricsOverride", {
      width: Math.ceil(layout.cssLayoutViewport.clientWidth),
      height: Math.min(Math.ceil(layout.cssContentSize.height), MAX_HEIGHT),
      deviceScaleFactor: 0,
      mobile: false,
    });
  }

  private async freeze(page: Page): Promise<void> {
    this.frozen.push(page);
    await call(page, "Emulation.setScriptExecutionDisabled", { value: true });
    await call(page, "Animation.setPlaybackRate", { playbackRate: 0 });
  }

  private async worlds(page: Page): Promise<Map<string, number>> {
    const tree = parseCdp(
      TreeSchema,
      await call(page, "Page.getFrameTree"),
      "the page's frames",
    ).frameTree;
    const worlds = new Map<string, number>();
    for (const frameId of idsOf(tree)) {
      const world = parseCdp(
        WorldSchema,
        await call(page, "Page.createIsolatedWorld", { frameId, worldName: WORLD }).catch(() => {
          throw unreachable();
        }),
        "a frame's world",
      );
      worlds.set(frameId, world.executionContextId);
    }
    return worlds;
  }

  private async hold(page: Page, expression: string, contextId: number): Promise<void> {
    const done = parseCdp(
      CoveredSchema,
      await call(page, "Runtime.evaluate", { expression, objectGroup: GROUP, contextId }),
      "the page's cover",
    );
    if (done.exceptionDetails !== undefined) throw unreachable();
    this.held.push({ page, objectId: done.result.objectId });
  }

  private async over(page: Page): Promise<void> {
    await this.freeze(page);
    const worlds = await this.worlds(page);
    for (const contextId of worlds.values()) await this.hold(page, `(${STYLE})()`, contextId);
    this.attached.push(page);
    await call(page, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    const children = this.children.get(page.session) ?? [];
    const documents = scan(await snapshotOf(page), this.needles);
    const remote = documents.reduce((total, doc) => total + doc.remote, 0);
    if (remote > children.length) throw unreachable();
    this.targets.push({ page, documents: documents.length, remote });
    for (const doc of documents) {
      const contextId = worlds.get(doc.frame);
      if (contextId === undefined) throw unreachable();
      const rects: Rect[] = doc.hits.map((hit) => hit.rect);
      await this.hold(page, `(${COVER})(${JSON.stringify(rects)})`, contextId);
    }
    for (const child of children) await this.over(child);
  }

  private async shapeOf(): Promise<string> {
    const shapes: string[] = [];
    for (const page of this.frozen) {
      const tree = parseCdp(
        TreeSchema,
        await call(page, "Page.getFrameTree").catch(() => {
          throw unstable();
        }),
        "the page's frames",
      );
      const children = String(this.children.get(page.session)?.length ?? 0);
      shapes.push([page.session, children, ...signature(tree.frameTree)].join(" "));
    }
    return shapes.join("\n");
  }
}
