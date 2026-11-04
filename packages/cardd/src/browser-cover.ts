import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { call, type Page } from "./browser-page.ts";

const GROUP = "fleet-cover";
const WORLD = "fleet-cover";
const MAX_HEIGHT = 16_384;

const SCAN = `(secrets) => {
  const squash = (text) => text.replace(/\\s+/g, " ");
  const needles = secrets.map(squash).filter((secret) => secret.trim() !== "");
  const hit = (text) => needles.some((needle) => squash(text).includes(needle));
  const skipped = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TITLE"];
  const roots = [document];
  for (let at = 0; at < roots.length; at += 1)
    for (const el of roots[at].querySelectorAll("*")) if (el.shadowRoot !== null) roots.push(el.shadowRoot);
  const rects = [];
  let frames = 0;
  const add = (box) => {
    if (box.width > 0 && box.height > 0) rects.push([box.left, box.top, box.width, box.height]);
  };
  for (const root of roots) {
    frames += root.querySelectorAll("iframe, frame").length;
    for (const el of root.querySelectorAll("input, textarea, select")) {
      const shown = el.tagName === "SELECT" ? [...el.options].map((option) => option.text).concat(el.value) : [el.value];
      if (el.__fleetFilled === true || shown.some(hit)) add(el.getBoundingClientRect());
    }
    for (const el of root.querySelectorAll("[placeholder], [alt]"))
      if (hit(el.getAttribute("placeholder") ?? "") || hit(el.getAttribute("alt") ?? "")) add(el.getBoundingClientRect());
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    const places = [];
    let last = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (skipped.includes(node.parentElement?.tagName ?? "")) continue;
      const text = node.nodeValue ?? "";
      for (let i = 0; i < text.length; i += 1) {
        const space = /\\s/.test(text[i]);
        if (space && last === " ") continue;
        last = space ? " " : text[i];
        parts.push(last);
        places.push([node, i]);
      }
    }
    const flat = parts.join("");
    for (const needle of needles) {
      for (let from = flat.indexOf(needle); from >= 0; from = flat.indexOf(needle, from + 1)) {
        const range = document.createRange();
        const start = places[from];
        const end = places[from + needle.length - 1];
        range.setStart(start[0], start[1]);
        range.setEnd(end[0], end[1] + 1);
        for (const box of range.getClientRects()) add(box);
      }
    }
  }
  return { rects, frames };
}`;

const COVER = `(secrets) => {
  const scan = ${SCAN};
  const { rects, frames } = scan(secrets);
  const container = document.createElement("div");
  container.style.cssText = "all: initial !important; display: block !important; position: absolute !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important;";
  document.documentElement.appendChild(container);
  for (const rect of rects) {
    const x = Math.floor(rect[0]) - 2;
    const y = Math.floor(rect[1]) - 2;
    const width = Math.ceil(rect[0] + rect[2]) + 2 - x;
    const height = Math.ceil(rect[1] + rect[3]) + 2 - y;
    const box = document.createElement("div");
    const place = (left, top) => {
      box.style.cssText = "all: initial !important; display: block !important; position: absolute !important; background: #000 !important; pointer-events: auto !important; left: " + left + "px !important; top: " + top + "px !important; width: " + width + "px !important; height: " + height + "px !important;";
    };
    place(x + scrollX, y + scrollY);
    container.appendChild(box);
    const at = box.getBoundingClientRect();
    place(x + scrollX + (x - at.left), y + scrollY + (y - at.top));
  }
  return { container, frames };
}`;

const VERIFY = `function (secrets) {
  const scan = ${SCAN};
  const { rects, frames } = scan(secrets);
  const container = this.container;
  const boxes = [...container.children].map((box) => box.getBoundingClientRect());
  let uncovered = 0;
  for (const [x, y, width, height] of rects) {
    const inside = boxes.some((b) => b.left <= x + 1 && b.top <= y + 1 && b.right >= x + width - 1 && b.bottom >= y + height - 1);
    const cx = x + width / 2;
    const cy = y + height / 2;
    const onScreen = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
    const top = onScreen ? document.elementFromPoint(cx, cy) : container;
    if (!inside || top === null || !container.contains(top)) uncovered += 1;
  }
  return { uncovered, frames, connected: container.isConnected };
}`;

const REMOVE = "function () { this.container.remove(); }";
const COUNT = "function () { return this.frames; }";

const CoveredSchema = Type.Object({
  result: Type.Object({ objectId: Type.String() }),
  exceptionDetails: Type.Optional(Type.Unknown()),
});
const CountSchema = Type.Object({ result: Type.Object({ value: Type.Integer() }) });
const VerifiedSchema = Type.Object({
  result: Type.Object({
    value: Type.Object({
      uncovered: Type.Integer(),
      frames: Type.Integer(),
      connected: Type.Boolean(),
    }),
  }),
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

interface Doc {
  readonly page: Page;
  readonly objectId: string;
  readonly frames: number;
}

const signature = (node: unknown): string[] => {
  const { frame, childFrames } = parseCdp(NodeSchema, node, "a frame");
  return [`${frame.id}@${frame.loaderId}`, ...(childFrames ?? []).flatMap(signature)];
};

export class Coverage {
  private readonly root: Page;
  private readonly secrets: readonly string[];
  private readonly docs: Doc[] = [];
  private readonly frozen: Page[] = [];
  private readonly attached: Page[] = [];
  private readonly children = new Map<string, Page[]>();
  private unlisten: (() => void) | undefined;
  private sized = false;
  private shape = "";

  constructor(root: Page, secrets: readonly string[]) {
    this.root = root;
    this.secrets = secrets;
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
    for (const doc of this.docs) {
      const seen = parseCdp(
        VerifiedSchema,
        await call(doc.page, "Runtime.callFunctionOn", {
          objectId: doc.objectId,
          functionDeclaration: VERIFY,
          arguments: [{ value: this.secrets }],
          returnByValue: true,
        }).catch(() => {
          throw unstable();
        }),
        "the covered page",
      );
      const { uncovered, frames, connected } = seen.result.value;
      if (seen.exceptionDetails !== undefined || !connected || uncovered > 0) throw unstable();
      if (frames !== doc.frames) throw unstable();
    }
  }

  async lift(): Promise<void> {
    this.unlisten?.();
    for (const doc of this.docs.toReversed())
      await call(doc.page, "Runtime.callFunctionOn", {
        objectId: doc.objectId,
        functionDeclaration: REMOVE,
      }).catch(() => undefined);
    for (const page of this.frozen)
      await call(page, "Emulation.setScriptExecutionDisabled", { value: false }).catch(
        () => undefined,
      );
    const pages = new Map(this.docs.map((doc) => [doc.page.session, doc.page]));
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

  private async over(page: Page): Promise<void> {
    this.frozen.push(page);
    await call(page, "Emulation.setScriptExecutionDisabled", { value: true });
    const main = await this.cover(page, undefined);
    const local = await this.coverLocal(page);
    this.attached.push(page);
    await call(page, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    const children = this.children.get(page.session) ?? [];
    if (local.reached + children.length < main + local.expected) throw unreachable();
    for (const child of children) await this.over(child);
  }

  private async coverLocal(page: Page): Promise<{ reached: number; expected: number }> {
    const tree = parseCdp(
      TreeSchema,
      await call(page, "Page.getFrameTree"),
      "the page's frames",
    ).frameTree;
    const below = (tree.childFrames ?? []).flatMap(signature).map((each) => each.split("@")[0]);
    let expected = 0;
    for (const frameId of below) {
      const world = parseCdp(
        WorldSchema,
        await call(page, "Page.createIsolatedWorld", { frameId, worldName: WORLD }).catch(() => {
          throw unreachable();
        }),
        "a frame's world",
      );
      expected += await this.cover(page, world.executionContextId);
    }
    return { reached: below.length, expected };
  }

  private async cover(page: Page, contextId: number | undefined): Promise<number> {
    const done = parseCdp(
      CoveredSchema,
      await call(page, "Runtime.evaluate", {
        expression: `(${COVER})(${JSON.stringify(this.secrets)})`,
        objectGroup: GROUP,
        ...(contextId === undefined ? {} : { contextId }),
      }),
      "the values to cover",
    );
    if (done.exceptionDetails !== undefined) throw unreachable();
    const { objectId } = done.result;
    const counted = parseCdp(
      CountSchema,
      await call(page, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: COUNT,
        returnByValue: true,
      }),
      "the frames to cover",
    );
    this.docs.push({ page, objectId, frames: counted.result.value });
    return counted.result.value;
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
