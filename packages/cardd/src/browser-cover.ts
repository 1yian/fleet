import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { needlesOf } from "./browser-hidden.ts";
import { call, type Page } from "./browser-page.ts";
import { pseudoShows, readTree, signatureOf, type Scope, type Tree } from "./browser-tree.ts";

const GROUP = "fleet-cover";
const WORLD = "fleet-cover";
const MAX_HEIGHT = 16_384;

const SCAN = `(scope, secrets) => {
  const unit = (c) => {
    if (/\\s/.test(c)) return " ";
    const lower = c.toLowerCase();
    return lower.length === 1 ? lower : c;
  };
  const fold = (text) => {
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
      const c = unit(text[i]);
      if (c !== " " || !out.endsWith(" ")) out += c;
    }
    return out;
  };
  const needles = secrets.map(fold).filter((needle) => needle.trim() !== "");
  const hit = (text) => {
    const folded = fold(text);
    return needles.some((needle) => folded.includes(needle));
  };
  const skipped = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TITLE"];
  const doc = scope.ownerDocument ?? scope;
  const rects = [];
  const add = (box) => {
    if (box.width > 0 && box.height > 0) rects.push([box.left, box.top, box.width, box.height]);
  };
  for (const el of scope.querySelectorAll("input, textarea, select")) {
    const shown = el.tagName === "SELECT" ? [...el.options].map((option) => option.text).concat(el.value) : [el.value];
    if (shown.some(hit)) add(el.getBoundingClientRect());
  }
  for (const el of scope.querySelectorAll("[placeholder], [alt]"))
    if (hit(el.getAttribute("placeholder") ?? "") || hit(el.getAttribute("alt") ?? "")) add(el.getBoundingClientRect());
  const walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const parts = [];
  const places = [];
  let last = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (skipped.includes(node.parentElement?.tagName ?? "")) continue;
    const text = node.nodeValue ?? "";
    for (let i = 0; i < text.length; i += 1) {
      const c = unit(text[i]);
      if (c === " " && last === " ") continue;
      last = c;
      parts.push(c);
      places.push([node, i]);
    }
  }
  const flat = parts.join("");
  for (const needle of needles) {
    for (let from = flat.indexOf(needle); from >= 0; from = flat.indexOf(needle, from + 1)) {
      const range = doc.createRange();
      const start = places[from];
      const end = places[from + needle.length - 1];
      range.setStart(start[0], start[1]);
      range.setEnd(end[0], end[1] + 1);
      for (const box of range.getClientRects()) add(box);
    }
  }
  return rects;
}`;

const SHEET =
  "*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: none !important; }";

const FREEZE = `function () {
  const style = (this.ownerDocument ?? this).createElement("style");
  style.textContent = ${JSON.stringify(SHEET)};
  (this.documentElement ?? this).appendChild(style);
  return style;
}`;

const SCAN_HERE = `function (secrets) {
  return (${SCAN})(this, secrets);
}`;

const COVER = `function (rects) {
  const doc = this.ownerDocument ?? this;
  const view = doc.defaultView;
  const container = doc.createElement("div");
  container.style.cssText = "all: initial !important; display: block !important; position: absolute !important; left: 0 !important; top: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important;";
  doc.documentElement.appendChild(container);
  for (const rect of rects) {
    const x = Math.floor(rect[0]) - 2;
    const y = Math.floor(rect[1]) - 2;
    const width = Math.ceil(rect[0] + rect[2]) + 2 - x;
    const height = Math.ceil(rect[1] + rect[3]) + 2 - y;
    const box = doc.createElement("div");
    const place = (left, top) => {
      box.style.cssText = "all: initial !important; display: block !important; position: absolute !important; background: #000 !important; left: " + left + "px !important; top: " + top + "px !important; width: " + width + "px !important; height: " + height + "px !important;";
    };
    place(x + view.scrollX, y + view.scrollY);
    container.appendChild(box);
    const at = box.getBoundingClientRect();
    place(x + view.scrollX + (x - at.left), y + view.scrollY + (y - at.top));
  }
  return container;
}`;

const VERIFY = `function (secrets, container) {
  const doc = this.ownerDocument ?? this;
  const rects = (${SCAN})(this, secrets);
  if (container !== null && !container.isConnected) return rects.length + 1;
  const boxes = container === null ? [] : [...container.children].map((box) => box.getBoundingClientRect());
  let uncovered = 0;
  for (const [x, y, width, height] of rects) {
    const inside = boxes.some((b) => b.left <= x + 1 && b.top <= y + 1 && b.right >= x + width - 1 && b.bottom >= y + height - 1);
    const cx = x + width / 2;
    const cy = y + height / 2;
    const onScreen = cx >= 0 && cy >= 0 && cx < doc.defaultView.innerWidth && cy < doc.defaultView.innerHeight;
    const top = onScreen ? doc.elementFromPoint(cx, cy) : container;
    if (!inside || top === null || container === null || !container.contains(top)) uncovered += 1;
  }
  return uncovered;
}`;

const REMOVE = "function () { this.remove(); }";

const ObjectSchema = Type.Object({
  result: Type.Object({ objectId: Type.String() }),
  exceptionDetails: Type.Optional(Type.Unknown()),
});
const ResolvedSchema = Type.Object({ object: Type.Object({ objectId: Type.String() }) });
const ValueSchema = Type.Object({
  result: Type.Object({ value: Type.Unknown() }),
  exceptionDetails: Type.Optional(Type.Unknown()),
});
const RectsSchema = Type.Array(Type.Array(Type.Number()));
const FrameNodeSchema = Type.Object({
  frame: Type.Object({ id: Type.String(), loaderId: Type.String() }),
  childFrames: Type.Optional(Type.Array(Type.Unknown())),
});
const FrameTreeSchema = Type.Object({ frameTree: FrameNodeSchema });
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
const closedRoot = (): Error =>
  refused(
    "a closed shadow root on the page shows a hidden value, and text in a closed shadow root cannot be covered",
  );
const drawn = (): Error =>
  refused(
    "the page draws a hidden value with a CSS pseudo-element (content: attr(...) or a string), which cannot be covered",
  );

interface Held {
  readonly page: Page;
  readonly objectId: string;
}

interface Checked {
  readonly page: Page;
  readonly scope: string;
  readonly container: string | null;
}

interface Target {
  readonly page: Page;
  readonly tree: Tree;
}

const idsOf = (node: unknown): string[] => {
  const { frame, childFrames } = parseCdp(FrameNodeSchema, node, "a frame");
  return [frame.id, ...(childFrames ?? []).flatMap(idsOf)];
};

const signature = (node: unknown): string[] => {
  const { frame, childFrames } = parseCdp(FrameNodeSchema, node, "a frame");
  return [`${frame.id}@${frame.loaderId}`, ...(childFrames ?? []).flatMap(signature)];
};

export class Coverage {
  private readonly root: Page;
  private readonly needles: readonly string[];
  private readonly held: Held[] = [];
  private readonly checked: Checked[] = [];
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
    for (const { page, tree } of this.targets) {
      const again = await readTree(page).catch(() => {
        throw unstable();
      });
      if (signatureOf(again) !== signatureOf(tree)) throw unstable();
      if (await this.drawnBy(page, again)) throw unstable();
    }
    for (const each of this.checked) if ((await this.uncovered(each)) > 0) throw unstable();
  }

  async lift(): Promise<void> {
    this.unlisten?.();
    for (const { page, objectId } of this.held.toReversed())
      await call(page, "Runtime.callFunctionOn", { objectId, functionDeclaration: REMOVE }).catch(
        () => undefined,
      );
    const pages = new Map(this.held.map((each) => [each.page.session, each.page]));
    for (const page of pages.values())
      await call(page, "Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
    for (const page of this.frozen) {
      await call(page, "CSS.disable").catch(() => undefined);
      await call(page, "DOM.disable").catch(() => undefined);
      await call(page, "Animation.setPlaybackRate", { playbackRate: 1 }).catch(() => undefined);
      await call(page, "Emulation.setScriptExecutionDisabled", { value: false }).catch(
        () => undefined,
      );
    }
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
    await call(page, "DOM.enable");
    await call(page, "CSS.enable");
  }

  private async worlds(page: Page): Promise<Map<string, number>> {
    const tree = parseCdp(
      FrameTreeSchema,
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

  private async resolve(
    page: Page,
    scope: Scope,
    worlds: ReadonlyMap<string, number>,
  ): Promise<string> {
    const executionContextId = worlds.get(scope.frame);
    if (executionContextId === undefined) throw unreachable();
    const done = parseCdp(
      ResolvedSchema,
      await call(page, "DOM.resolveNode", {
        nodeId: scope.nodeId,
        executionContextId,
        objectGroup: GROUP,
      }).catch(() => {
        throw unreachable();
      }),
      "a scope of the page",
    );
    return done.object.objectId;
  }

  private async hold(
    page: Page,
    objectId: string,
    declaration: string,
    args: unknown[],
  ): Promise<string> {
    const done = parseCdp(
      ObjectSchema,
      await call(page, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: declaration,
        arguments: args,
        objectGroup: GROUP,
      }),
      "the page's cover",
    );
    if (done.exceptionDetails !== undefined) throw unreachable();
    this.held.push({ page, objectId: done.result.objectId });
    return done.result.objectId;
  }

  private async rectsIn(page: Page, scope: string): Promise<number[][]> {
    const done = parseCdp(
      ValueSchema,
      await call(page, "Runtime.callFunctionOn", {
        objectId: scope,
        functionDeclaration: SCAN_HERE,
        arguments: [{ value: this.needles }],
        returnByValue: true,
      }),
      "the page's values",
    );
    if (done.exceptionDetails !== undefined) throw unreachable();
    return parseCdp(RectsSchema, done.result.value, "the page's values");
  }

  private async uncovered(each: Checked): Promise<number> {
    const done = parseCdp(
      ValueSchema,
      await call(each.page, "Runtime.callFunctionOn", {
        objectId: each.scope,
        functionDeclaration: VERIFY,
        arguments: [
          { value: this.needles },
          each.container === null ? { value: null } : { objectId: each.container },
        ],
        returnByValue: true,
      }).catch(() => {
        throw unstable();
      }),
      "the covered page",
    );
    return typeof done.result.value === "number" && done.exceptionDetails === undefined
      ? done.result.value
      : 1;
  }

  private async drawnBy(page: Page, tree: Tree): Promise<boolean> {
    return pseudoShows(page, tree, this.needles).catch(() => {
      throw unreachable();
    });
  }

  private async cover(page: Page, scope: Scope, objectId: string): Promise<void> {
    const rects = await this.rectsIn(page, objectId);
    if (rects.length > 0 && scope.closed) throw closedRoot();
    const container =
      rects.length === 0 ? null : await this.hold(page, objectId, COVER, [{ value: rects }]);
    this.checked.push({ page, scope: objectId, container });
  }

  private async over(page: Page): Promise<void> {
    await this.freeze(page);
    const worlds = await this.worlds(page);
    const tree = await readTree(page);
    this.attached.push(page);
    await call(page, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    const children = this.children.get(page.session) ?? [];
    if (tree.remote > children.length) throw unreachable();
    const scopes = new Map<Scope, string>();
    for (const scope of tree.scopes) {
      const objectId = await this.resolve(page, scope, worlds);
      scopes.set(scope, objectId);
      await this.hold(page, objectId, FREEZE, []);
    }
    if (await this.drawnBy(page, tree)) throw drawn();
    for (const [scope, objectId] of scopes) await this.cover(page, scope, objectId);
    this.targets.push({ page, tree });
    for (const child of children) await this.over(child);
  }

  private async shapeOf(): Promise<string> {
    const shapes: string[] = [];
    for (const page of this.frozen) {
      const tree = parseCdp(
        FrameTreeSchema,
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
