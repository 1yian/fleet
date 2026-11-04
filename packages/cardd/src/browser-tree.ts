import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { call, type Page } from "./browser-page.ts";

const ShadowSchema = Type.Object({ nodeId: Type.Integer(), shadowRootType: Type.String() });
const FlatNodeSchema = Type.Object({
  nodeId: Type.Integer(),
  parentId: Type.Optional(Type.Integer()),
  nodeType: Type.Integer(),
  nodeName: Type.String(),
  frameId: Type.Optional(Type.String()),
  shadowRoots: Type.Optional(Type.Array(ShadowSchema)),
  pseudoElements: Type.Optional(Type.Array(Type.Object({ nodeId: Type.Integer() }))),
  contentDocument: Type.Optional(Type.Object({ nodeId: Type.Integer() })),
});
const FlatSchema = Type.Object({ nodes: Type.Array(FlatNodeSchema) });
const ComputedSchema = Type.Object({
  computedStyle: Type.Array(Type.Object({ name: Type.String(), value: Type.String() })),
});

type FlatNode = Type.Static<typeof FlatNodeSchema>;

export interface Scope {
  readonly nodeId: number;
  readonly frame: string;
  readonly closed: boolean;
}

export interface Tree {
  readonly scopes: readonly Scope[];
  readonly pseudo: readonly number[];
  readonly remote: number;
}

interface Index {
  readonly parents: ReadonlyMap<number, number>;
  readonly shadows: ReadonlyMap<number, string>;
  readonly frames: ReadonlyMap<number, string>;
}

function indexOf(nodes: readonly FlatNode[]): Index {
  const parents = new Map<number, number>();
  const shadows = new Map<number, string>();
  const frames = new Map<number, string>();
  for (const node of nodes) {
    if (node.parentId !== undefined) parents.set(node.nodeId, node.parentId);
    if (node.frameId !== undefined) frames.set(node.nodeId, node.frameId);
    if (node.contentDocument !== undefined) parents.set(node.contentDocument.nodeId, node.nodeId);
    for (const root of node.shadowRoots ?? []) {
      parents.set(root.nodeId, node.nodeId);
      shadows.set(root.nodeId, root.shadowRootType);
    }
  }
  return { parents, shadows, frames };
}

function closedAbove(index: Index, from: number): boolean {
  for (let at: number | undefined = from; at !== undefined; at = index.parents.get(at))
    if (index.shadows.get(at) === "closed") return true;
  return false;
}

function frameOf(index: Index, from: number): string | undefined {
  for (let at: number | undefined = from; at !== undefined; at = index.parents.get(at)) {
    const frame = index.frames.get(at);
    if (frame !== undefined) return frame;
  }
  return undefined;
}

function documentScopes(nodes: readonly FlatNode[], index: Index, node: FlatNode): Scope[] {
  if (node.nodeType === 9) {
    const root = nodes.find((each) => each.parentId === node.nodeId && each.frameId !== undefined);
    return root?.frameId === undefined
      ? []
      : [{ nodeId: node.nodeId, frame: root.frameId, closed: false }];
  }
  if (node.contentDocument === undefined || node.frameId === undefined) return [];
  return [
    {
      nodeId: node.contentDocument.nodeId,
      frame: node.frameId,
      closed: closedAbove(index, node.nodeId),
    },
  ];
}

function shadowScopes(index: Index, node: FlatNode): Scope[] {
  const frame = frameOf(index, node.nodeId);
  if (frame === undefined) return [];
  return (node.shadowRoots ?? [])
    .filter((root) => root.shadowRootType !== "user-agent")
    .map((root) => ({
      nodeId: root.nodeId,
      frame,
      closed: root.shadowRootType === "closed" || closedAbove(index, node.nodeId),
    }));
}

const scopesOf = (nodes: readonly FlatNode[], index: Index): Scope[] =>
  nodes.flatMap((node) => [...documentScopes(nodes, index, node), ...shadowScopes(index, node)]);

const isFrameOwner = (node: FlatNode): boolean =>
  ["IFRAME", "FRAME"].includes(node.nodeName.toUpperCase());

export async function readTree(page: Page): Promise<Tree> {
  const { nodes } = parseCdp(
    FlatSchema,
    await call(page, "DOM.getFlattenedDocument", { depth: -1, pierce: true }),
    "the page's tree",
  );
  return {
    scopes: scopesOf(nodes, indexOf(nodes)),
    pseudo: nodes.flatMap((node) => (node.pseudoElements ?? []).map((each) => each.nodeId)),
    remote: nodes.filter((node) => isFrameOwner(node) && node.contentDocument === undefined).length,
  };
}

export const signatureOf = (tree: Tree): string =>
  [
    String(tree.remote),
    String(tree.pseudo.length),
    ...tree.scopes.map((scope) => `${scope.frame}:${String(scope.closed)}`),
  ].join(" ");

function unit(char: string): string {
  if (/\s/.test(char)) return " ";
  const lower = char.toLowerCase();
  return lower.length === 1 ? lower : char;
}

function fold(text: string): string {
  let out = "";
  for (const char of text) {
    const next = unit(char);
    if (next !== " " || !out.endsWith(" ")) out += next;
  }
  return out;
}

function unescaped(text: string): string {
  return text.replace(
    /\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g,
    (_all, hex?: string, char?: string) => {
      if (hex === undefined) return char ?? "";
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code);
    },
  );
}

function literals(css: string): string[] {
  return [...css.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((found) =>
    unescaped(found[1] ?? found[2] ?? ""),
  );
}

function shows(css: string, needles: readonly string[]): boolean {
  const parts = literals(css);
  const seen = [css, ...parts, parts.join("")].map(fold);
  return needles
    .map(fold)
    .filter((needle) => needle.trim() !== "")
    .some((needle) => seen.some((text) => text.includes(needle)));
}

export async function pseudoShows(
  page: Page,
  tree: Tree,
  needles: readonly string[],
): Promise<boolean> {
  for (const nodeId of tree.pseudo) {
    const style = parseCdp(
      ComputedSchema,
      await call(page, "CSS.getComputedStyleForNode", { nodeId }),
      "a pseudo-element's style",
    );
    const content = style.computedStyle.find((each) => each.name === "content")?.value ?? "";
    if (shows(content, needles)) return true;
  }
  return false;
}
