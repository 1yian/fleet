import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { exposure } from "./browser-hidden.ts";
import { call, type Page } from "./browser-page.ts";

const GROUP = "fleet-scan";
const WORLD = "fleet-scan";

const SCAN = `function (count, ...nodes) {
  const closed = new Map();
  for (let i = 0; i < count; i += 2) closed.set(nodes[i], nodes[i + 1]);
  const undrawn = new Set(nodes.slice(count));
  const rootOf = (el) => el.shadowRoot ?? closed.get(el) ?? null;
  const doc = this.ownerDocument ?? this;
  const view = doc.defaultView;
  const unescaped = (text) => text.replace(/\\\\([0-9a-fA-F]{1,6})\\s?|\\\\([\\s\\S])/g, (all, hex, char) => {
    if (hex === undefined) return char;
    const code = Number.parseInt(hex, 16);
    return code === 0 || code > 0x10ffff ? "\\ufffd" : String.fromCodePoint(code);
  });
  const generated = (el, which) => {
    const style = view.getComputedStyle(el, which);
    if (style.display === "none") return "";
    return [...style.content.matchAll(/"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'/g)]
      .map((found) => unescaped(found[1] ?? found[2] ?? ""))
      .join("");
  };
  const styleOf = (el) => {
    try {
      return view.getComputedStyle(el);
    } catch (error) {
      return null;
    }
  };
  const boxed = (node) => {
    try {
      const range = doc.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
    } catch (error) {
      return true;
    }
  };
  const innerOf = (node) => (node.nodeType === 3 ? node.nodeValue : node.innerText) ?? "";
  const fields = ["INPUT", "TEXTAREA", "SELECT"];
  const views = [];
  const queue = [this];
  for (const parent of queue) {
    for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      for (const attribute of node.attributes) views.push(attribute.value);
      if (fields.includes(node.tagName)) views.push(node.value);
      if (node.tagName === "OPTION") views.push(node.text);
      queue.push(node);
      const root = rootOf(node);
      if (root === null) continue;
      queue.push(root);
      views.push([...root.childNodes].map(innerOf).join(""));
    }
  }
  const flat = (el) => {
    const root = rootOf(el);
    if (root !== null) return [...root.childNodes];
    return el.tagName === "SLOT" ? el.assignedNodes({ flatten: true }) : [...el.childNodes];
  };
  const text = [];
  const stack = [{ nodes: [...this.childNodes], at: 0, shown: true, visible: true, tail: "" }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.at >= top.nodes.length) {
      stack.pop();
      text.push(top.tail);
      continue;
    }
    const node = top.nodes[top.at];
    top.at += 1;
    if (node.nodeType === 3) {
      if (top.shown && top.visible && !undrawn.has(node) && boxed(node)) text.push(node.nodeValue ?? "");
    } else if (node.nodeType === 1) {
      const style = styleOf(node);
      const shown = top.shown && (style === null || style.display !== "none");
      const contents = shown && (style === null || style.contentVisibility !== "hidden");
      const visible = style === null || style.visibility === "visible";
      const drawn = contents && visible;
      text.push(drawn ? generated(node, "::before") : "");
      stack.push({ nodes: flat(node), at: 0, shown: contents, visible, tail: drawn ? generated(node, "::after") : "" });
    }
  }
  views.push(text.join(""));
  if (this.nodeType === 9) views.push(this.body?.innerText ?? "");
  return views;
}`;

const FlatNodeSchema = Type.Object({
  nodeId: Type.Integer(),
  parentId: Type.Optional(Type.Integer()),
  nodeType: Type.Integer(),
  nodeName: Type.String(),
  frameId: Type.Optional(Type.String()),
  shadowRoots: Type.Optional(
    Type.Array(Type.Object({ nodeId: Type.Integer(), shadowRootType: Type.String() })),
  ),
  contentDocument: Type.Optional(Type.Object({ nodeId: Type.Integer() })),
});
const FlatSchema = Type.Object({ nodes: Type.Array(FlatNodeSchema) });
const ResolvedSchema = Type.Object({ object: Type.Object({ objectId: Type.String() }) });
const ValueSchema = Type.Object({
  result: Type.Object({ value: Type.Optional(Type.Unknown()) }),
  exceptionDetails: Type.Optional(Type.Unknown()),
});
const ViewsSchema = Type.Array(Type.String());
const QuadsSchema = Type.Object({
  quads: Type.Array(Type.Array(Type.Number(), { minItems: 8, maxItems: 8 })),
});
const FrameNodeSchema = Type.Object({
  frame: Type.Object({ id: Type.String() }),
  childFrames: Type.Optional(Type.Array(Type.Unknown())),
});
const FrameTreeSchema = Type.Object({ frameTree: FrameNodeSchema });
const WorldSchema = Type.Object({ executionContextId: Type.Integer() });
const AttachedSchema = Type.Object({
  sessionId: Type.String(),
  targetInfo: Type.Object({ type: Type.String() }),
});

type FlatNode = Type.Static<typeof FlatNodeSchema>;

interface Scope {
  readonly nodeId: number;
  readonly frame: string;
  readonly closed: readonly number[];
  readonly texts: readonly number[];
}

const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const MIN_AREA = 1;

const unreadable = (): Error =>
  new Error(
    "no picture was returned: a part of the page could not be scanned, so it is not known whether it shows a stored credential",
  );

export const CREDENTIAL_SHOWN =
  "no picture was returned: this page shows a stored credential; read it as text, which hides it, or move past the login form";

const idsOf = (node: unknown): string[] => {
  const { frame, childFrames } = parseCdp(FrameNodeSchema, node, "a frame");
  return [frame.id, ...(childFrames ?? []).flatMap(idsOf)];
};

function frameOf(
  parents: ReadonlyMap<number, number>,
  frames: ReadonlyMap<number, string>,
  from: number,
): string | undefined {
  for (let at: number | undefined = from; at !== undefined; at = parents.get(at)) {
    const frame = frames.get(at);
    if (frame !== undefined) return frame;
  }
  return undefined;
}

function indexOf(nodes: readonly FlatNode[]): {
  parents: Map<number, number>;
  frames: Map<number, string>;
} {
  const parents = new Map<number, number>();
  const frames = new Map<number, string>();
  for (const node of nodes) {
    if (node.parentId !== undefined) parents.set(node.nodeId, node.parentId);
    if (node.frameId !== undefined) frames.set(node.nodeId, node.frameId);
    if (node.contentDocument !== undefined) parents.set(node.contentDocument.nodeId, node.nodeId);
    for (const root of node.shadowRoots ?? []) parents.set(root.nodeId, node.nodeId);
  }
  return { parents, frames };
}

function areaOf(quad: readonly number[]): number {
  let twice = 0;
  for (let at = 0; at < 8; at += 2) {
    const next = (at + 2) % 8;
    twice += (quad[at] ?? 0) * (quad[next + 1] ?? 0) - (quad[next] ?? 0) * (quad[at + 1] ?? 0);
  }
  return Math.abs(twice) / 2;
}

async function drawn(page: Page, nodeId: number): Promise<boolean> {
  try {
    const { quads } = parseCdp(
      QuadsSchema,
      await call(page, "DOM.getContentQuads", { nodeId }),
      "a text's boxes",
    );
    return quads.some((quad) => areaOf(quad) >= MIN_AREA);
  } catch {
    return true;
  }
}

function textsOf(
  nodes: readonly FlatNode[],
  parents: ReadonlyMap<number, number>,
): Map<number, number[]> {
  const types = new Map(nodes.map((node) => [node.nodeId, node.nodeType]));
  const owned = new Map<number, number[]>();
  for (const node of nodes) {
    if (node.nodeType !== TEXT_NODE) continue;
    let at = parents.get(node.nodeId);
    while (at !== undefined && types.get(at) !== DOCUMENT_NODE) at = parents.get(at);
    if (at === undefined) continue;
    const own = owned.get(at);
    if (own === undefined) owned.set(at, [node.nodeId]);
    else own.push(node.nodeId);
  }
  return owned;
}

function scopesOf(nodes: readonly FlatNode[]): Scope[] {
  const { parents, frames } = indexOf(nodes);
  const texts = textsOf(nodes, parents);
  const closed = new Map<string, number[]>();
  for (const node of nodes)
    for (const root of node.shadowRoots ?? []) {
      if (root.shadowRootType !== "closed") continue;
      const frame = frameOf(parents, frames, node.nodeId);
      if (frame === undefined) throw unreadable();
      closed.set(frame, [...(closed.get(frame) ?? []), node.nodeId, root.nodeId]);
    }
  const scopes = nodes
    .filter((node) => node.nodeType === DOCUMENT_NODE)
    .map((node) => {
      const frame = nodes.find(
        (each) => each.parentId === node.nodeId && each.frameId !== undefined,
      )?.frameId;
      if (frame === undefined) throw unreadable();
      return {
        nodeId: node.nodeId,
        frame,
        closed: closed.get(frame) ?? [],
        texts: texts.get(node.nodeId) ?? [],
      };
    });
  for (const frame of closed.keys())
    if (!scopes.some((scope) => scope.frame === frame)) throw unreadable();
  return scopes;
}

const isFrameOwner = (node: FlatNode): boolean =>
  ["IFRAME", "FRAME"].includes(node.nodeName.toUpperCase());

class Scan {
  private readonly exposed: (text: string) => boolean;
  private readonly touched: Page[] = [];
  private readonly children = new Map<string, Page[]>();
  private unlisten: (() => void) | undefined;

  constructor(exposed: (text: string) => boolean) {
    this.exposed = exposed;
  }

  async shows(root: Page): Promise<boolean> {
    this.unlisten = root.cdp.listen((event) => {
      if (event.method !== "Target.attachedToTarget" || event.sessionId === undefined) return;
      const attached = parseCdp(AttachedSchema, event.params, "an attached frame");
      if (attached.targetInfo.type !== "iframe") return;
      const found = this.children.get(event.sessionId) ?? [];
      found.push({ cdp: root.cdp, session: attached.sessionId });
      this.children.set(event.sessionId, found);
    });
    return this.over(root);
  }

  async lift(): Promise<void> {
    this.unlisten?.();
    for (const page of this.touched) {
      await call(page, "Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
      await call(page, "DOM.disable").catch(() => undefined);
      await call(page, "Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      }).catch(() => undefined);
    }
  }

  private async over(page: Page): Promise<boolean> {
    this.touched.push(page);
    await call(page, "DOM.enable");
    const worlds = await this.worlds(page);
    const { nodes } = parseCdp(
      FlatSchema,
      await call(page, "DOM.getFlattenedDocument", { depth: -1, pierce: true }),
      "the page's tree",
    );
    await call(page, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    const children = this.children.get(page.session) ?? [];
    if (
      nodes.filter((node) => isFrameOwner(node) && node.contentDocument === undefined).length >
      children.length
    )
      throw unreadable();
    for (const scope of scopesOf(nodes)) if (await this.shown(page, scope, worlds)) return true;
    for (const child of children) if (await this.over(child)) return true;
    return false;
  }

  private async worlds(page: Page): Promise<Map<string, number>> {
    const { frameTree } = parseCdp(
      FrameTreeSchema,
      await call(page, "Page.getFrameTree"),
      "the page's frames",
    );
    const worlds = new Map<string, number>();
    for (const frameId of idsOf(frameTree)) {
      const world = parseCdp(
        WorldSchema,
        await call(page, "Page.createIsolatedWorld", { frameId, worldName: WORLD }).catch(() => {
          throw unreadable();
        }),
        "a frame's world",
      );
      worlds.set(frameId, world.executionContextId);
    }
    return worlds;
  }

  private resolveAll(
    page: Page,
    nodeIds: readonly number[],
    executionContextId: number,
  ): Promise<{ objectId: string }[]> {
    return Promise.all(
      nodeIds.map(async (nodeId) => ({
        objectId: await this.resolve(page, nodeId, executionContextId),
      })),
    );
  }

  private async resolve(page: Page, nodeId: number, executionContextId: number): Promise<string> {
    const resolved = parseCdp(
      ResolvedSchema,
      await call(page, "DOM.resolveNode", { nodeId, executionContextId, objectGroup: GROUP }).catch(
        () => {
          throw unreadable();
        },
      ),
      "a scope of the page",
    );
    return resolved.object.objectId;
  }

  private async shown(
    page: Page,
    scope: Scope,
    worlds: ReadonlyMap<string, number>,
  ): Promise<boolean> {
    const executionContextId = worlds.get(scope.frame);
    if (executionContextId === undefined) throw unreadable();
    const objectId = await this.resolve(page, scope.nodeId, executionContextId);
    const closed = await this.resolveAll(page, scope.closed, executionContextId);
    const checked = await Promise.all(
      scope.texts.map(async (nodeId) => ({ nodeId, shown: await drawn(page, nodeId) })),
    );
    const undrawn = await this.resolveAll(
      page,
      checked.filter((each) => !each.shown).map((each) => each.nodeId),
      executionContextId,
    );
    const done = parseCdp(
      ValueSchema,
      await call(page, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: SCAN,
        arguments: [{ value: closed.length }, ...closed, ...undrawn],
        returnByValue: true,
      }).catch(() => {
        throw unreadable();
      }),
      "the page's scan",
    );
    if (done.exceptionDetails !== undefined) throw unreadable();
    return parseCdp(ViewsSchema, done.result.value, "the page's text").some(this.exposed);
  }
}

export async function showsCredential(page: Page, secrets: readonly string[]): Promise<boolean> {
  const scan = new Scan(exposure(secrets));
  try {
    return await scan.shows(page);
  } finally {
    await scan.lift();
  }
}
