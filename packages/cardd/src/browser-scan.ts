import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { needlesOf } from "./browser-hidden.ts";
import { call, type Page } from "./browser-page.ts";

const GROUP = "fleet-scan";
const WORLD = "fleet-scan";

const SCAN = `function (secrets) {
  const unit = (c) => {
    if (/\\s/.test(c)) return " ";
    const lower = c.toLowerCase();
    return lower.length === 1 ? lower : c;
  };
  const fold = (text) => {
    let out = "";
    for (const c of text) {
      const next = unit(c);
      if (next !== " " || !out.endsWith(" ")) out += next;
    }
    return out;
  };
  const needles = secrets.map(fold).filter((needle) => needle.trim() !== "");
  const hit = (text) => {
    const folded = fold(text);
    return needles.some((needle) => folded.includes(needle));
  };
  const unescaped = (text) => text.replace(/\\\\([0-9a-fA-F]{1,6})\\s?|\\\\([\\s\\S])/g, (all, hex, char) => {
    if (hex === undefined) return char;
    const code = Number.parseInt(hex, 16);
    return code === 0 || code > 0x10ffff ? "\\ufffd" : String.fromCodePoint(code);
  });
  const doc = this.ownerDocument ?? this;
  const view = doc.defaultView;
  const generated = (el, which) => {
    const content = view.getComputedStyle(el, which).content;
    return [...content.matchAll(/"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'/g)]
      .map((found) => unescaped(found[1] ?? found[2] ?? ""))
      .join("");
  };
  const unrendered = ["SCRIPT", "STYLE", "NOSCRIPT", "TITLE"];
  const fields = ["INPUT", "TEXTAREA", "SELECT"];
  const text = [];
  const stack = [[this, this.firstChild]];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const node = top[1];
    if (node === null) {
      stack.pop();
      if (top[0].nodeType === 1) text.push(generated(top[0], "::after"));
      continue;
    }
    top[1] = node.nextSibling;
    if (node.nodeType === 3) {
      if (!unrendered.includes(node.parentElement?.tagName ?? "")) text.push(node.nodeValue ?? "");
    } else if (node.nodeType === 1) {
      for (const attribute of node.attributes) if (hit(attribute.value)) return true;
      if (fields.includes(node.tagName) && hit(node.value)) return true;
      text.push(generated(node, "::before"));
      stack.push([node, node.firstChild]);
    }
  }
  return hit(text.join(""));
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
}

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

function scopesOf(nodes: readonly FlatNode[]): Scope[] {
  const { parents, frames } = indexOf(nodes);
  const roots: [number, string | undefined][] = [];
  for (const node of nodes) {
    if (node.nodeType === 9)
      roots.push([
        node.nodeId,
        nodes.find((each) => each.parentId === node.nodeId && each.frameId !== undefined)?.frameId,
      ]);
    for (const root of node.shadowRoots ?? [])
      if (root.shadowRootType !== "user-agent")
        roots.push([root.nodeId, frameOf(parents, frames, node.nodeId)]);
  }
  return roots.map(([nodeId, frame]) => {
    if (frame === undefined) throw unreadable();
    return { nodeId, frame };
  });
}

const isFrameOwner = (node: FlatNode): boolean =>
  ["IFRAME", "FRAME"].includes(node.nodeName.toUpperCase());

class Scan {
  private readonly needles: readonly string[];
  private readonly touched: Page[] = [];
  private readonly children = new Map<string, Page[]>();
  private unlisten: (() => void) | undefined;

  constructor(needles: readonly string[]) {
    this.needles = needles;
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

  private async shown(
    page: Page,
    scope: Scope,
    worlds: ReadonlyMap<string, number>,
  ): Promise<boolean> {
    const executionContextId = worlds.get(scope.frame);
    if (executionContextId === undefined) throw unreadable();
    const resolved = parseCdp(
      ResolvedSchema,
      await call(page, "DOM.resolveNode", {
        nodeId: scope.nodeId,
        executionContextId,
        objectGroup: GROUP,
      }).catch(() => {
        throw unreadable();
      }),
      "a scope of the page",
    );
    const done = parseCdp(
      ValueSchema,
      await call(page, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: SCAN,
        arguments: [{ value: this.needles }],
        returnByValue: true,
      }).catch(() => {
        throw unreadable();
      }),
      "the page's scan",
    );
    if (done.exceptionDetails !== undefined || typeof done.result.value !== "boolean")
      throw unreadable();
    return done.result.value;
  }
}

export async function showsCredential(page: Page, secrets: readonly string[]): Promise<boolean> {
  const scan = new Scan(needlesOf(secrets));
  try {
    return await scan.shows(page);
  } finally {
    await scan.lift();
  }
}
