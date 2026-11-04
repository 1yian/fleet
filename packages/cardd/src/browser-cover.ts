import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { call, type Page } from "./browser-page.ts";

const GROUP = "fleet-mask";
const WORLD = "fleet-mask";

const MASK = `(secrets) => {
  const ordered = secrets.filter((secret) => secret !== "").sort((a, b) => b.length - a.length);
  const blank = (text) => ordered.reduce((out, secret) => out.split(secret).join("\\u2022".repeat(secret.length)), text);
  const props = ["-webkit-text-fill-color", "color", "caret-color", "text-shadow"];
  const covered = (el) =>
    el.__fleetFilled === true ||
    (el.value !== "" && ordered.some((secret) => el.value.includes(secret)));
  const skipped = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TITLE"];
  const undo = [];
  const roots = [document];
  for (let at = 0; at < roots.length; at += 1)
    for (const el of roots[at].querySelectorAll("*")) if (el.shadowRoot !== null) roots.push(el.shadowRoot);
  let frames = 0;
  for (const root of roots) {
    frames += root.querySelectorAll("iframe, frame").length;
    for (const el of root.querySelectorAll("input, textarea")) {
      if (!covered(el)) continue;
      const saved = props.map((name) => [name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)]);
      undo.push(() => {
        for (const [name, value, priority] of saved) {
          if (value === "") el.style.removeProperty(name);
          else el.style.setProperty(name, value, priority);
        }
      });
      for (const name of props) el.style.setProperty(name, name === "text-shadow" ? "none" : "transparent", "important");
    }
    for (const el of root.querySelectorAll("[placeholder], [alt]")) {
      for (const name of ["placeholder", "alt"]) {
        const before = el.getAttribute(name);
        if (before === null || blank(before) === before) continue;
        undo.push(() => el.setAttribute(name, before));
        el.setAttribute(name, blank(before));
      }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const before = node.nodeValue ?? "";
      if (skipped.includes(node.parentElement?.tagName ?? "") || blank(before) === before) continue;
      undo.push(() => { node.nodeValue = before; });
      node.nodeValue = blank(before);
    }
  }
  return { undo, frames };
}`;

const UNMASK = `function () {
  for (const restore of this.undo) restore();
}`;

const MaskedSchema = Type.Object({
  result: Type.Object({ objectId: Type.String() }),
  exceptionDetails: Type.Optional(Type.Unknown()),
});
const CountSchema = Type.Object({ result: Type.Object({ value: Type.Integer() }) });
const NodeSchema = Type.Object({
  frame: Type.Object({ id: Type.String() }),
  childFrames: Type.Optional(Type.Array(Type.Unknown())),
});
const TreeSchema = Type.Object({ frameTree: NodeSchema });
const WorldSchema = Type.Object({ executionContextId: Type.Integer() });
const AttachedSchema = Type.Object({
  sessionId: Type.String(),
  targetInfo: Type.Object({ type: Type.String() }),
});

interface Held {
  readonly page: Page;
  readonly objectId: string;
}

export interface Cover {
  readonly held: Held[];
  readonly attached: Page[];
}

export const newCover = (): Cover => ({ held: [], attached: [] });

const unreachable = (): Error =>
  new Error(
    "a frame on the page could not be covered, so no picture was taken: a value that it shows could not be hidden",
  );

async function maskIn(
  page: Page,
  secrets: readonly string[],
  contextId: number | undefined,
): Promise<{ held: Held; frames: number }> {
  const done = parseCdp(
    MaskedSchema,
    await call(page, "Runtime.evaluate", {
      expression: `(${MASK})(${JSON.stringify(secrets)})`,
      objectGroup: GROUP,
      ...(contextId === undefined ? {} : { contextId }),
    }),
    "the fields to hide",
  );
  if (done.exceptionDetails !== undefined) throw unreachable();
  const { objectId } = done.result;
  const counted = parseCdp(
    CountSchema,
    await call(page, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return this.frames; }",
      returnByValue: true,
    }),
    "the frames to hide",
  );
  return { held: { page, objectId }, frames: counted.result.value };
}

const idsBelow = (children: readonly unknown[]): string[] =>
  children.flatMap((child) => {
    const node = parseCdp(NodeSchema, child, "a frame");
    return [node.frame.id, ...idsBelow(node.childFrames ?? [])];
  });

async function attachChildren(cover: Cover, page: Page): Promise<Page[]> {
  const children: Page[] = [];
  const stop = page.cdp.listen((event) => {
    if (event.method !== "Target.attachedToTarget" || event.sessionId !== page.session) return;
    const attached = parseCdp(AttachedSchema, event.params, "an attached frame");
    if (attached.targetInfo.type === "iframe")
      children.push({ cdp: page.cdp, session: attached.sessionId });
  });
  try {
    cover.attached.push(page);
    await call(page, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } finally {
    stop();
  }
  return children;
}

async function coverLocalFrames(
  cover: Cover,
  page: Page,
  secrets: readonly string[],
): Promise<{ frames: number; expected: number }> {
  const tree = parseCdp(
    TreeSchema,
    await call(page, "Page.getFrameTree"),
    "the page's frames",
  ).frameTree;
  let expected = 0;
  const below = idsBelow(tree.childFrames ?? []);
  for (const frameId of below) {
    const world = parseCdp(
      WorldSchema,
      await call(page, "Page.createIsolatedWorld", { frameId, worldName: WORLD }).catch(() => {
        throw unreachable();
      }),
      "a frame's world",
    );
    const inner = await maskIn(page, secrets, world.executionContextId);
    cover.held.push(inner.held);
    expected += inner.frames;
  }
  return { frames: below.length, expected };
}

export async function coverPage(
  cover: Cover,
  page: Page,
  secrets: readonly string[],
): Promise<void> {
  const main = await maskIn(page, secrets, undefined);
  cover.held.push(main.held);
  const local = await coverLocalFrames(cover, page, secrets);
  const children = await attachChildren(cover, page);
  if (local.frames + children.length < main.frames + local.expected) throw unreachable();
  for (const child of children) await coverPage(cover, child, secrets);
}

export async function liftCover(cover: Cover): Promise<void> {
  for (const { page, objectId } of cover.held.toReversed())
    await call(page, "Runtime.callFunctionOn", { objectId, functionDeclaration: UNMASK }).catch(
      () => undefined,
    );
  const pages = new Map(cover.held.map((held) => [held.page.session, held.page]));
  for (const page of pages.values())
    await call(page, "Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => undefined);
  for (const page of cover.attached)
    await call(page, "Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => undefined);
}
