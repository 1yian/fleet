import Type from "typebox";
import { parseCdp, type Cdp } from "./cdp.ts";

const COPY_LIMIT = 1_000_000;
const WORLD = "fleet-selection";

const WALK = `
  const focused = (doc) => {
    let element = doc.activeElement;
    while (element !== null && element.shadowRoot !== null && element.shadowRoot.activeElement !== null)
      element = element.shadowRoot.activeElement;
    return element;
  };
  const docs = [document];
  let unreachable = null;
  for (;;) {
    const element = focused(docs[docs.length - 1]);
    if (element === null || element.tagName !== "IFRAME") break;
    let inner = null;
    try {
      inner = element.contentDocument;
    } catch {
      inner = null;
    }
    if (inner === null) {
      unreachable = element;
      break;
    }
    docs.push(inner);
  }
`;

const SELECTION = `(() => {${WALK}
  const doc = docs[docs.length - 1];
  const field = focused(doc);
  try {
    if (field !== null && field.tagName === "INPUT" && field.type === "password" && field.selectionStart !== field.selectionEnd)
      return "";
  } catch {
    return "";
  }
  return doc.getSelection().toString();
})()`;

const UNREACHABLE_FRAME = `(() => {${WALK}
  return unreachable;
})()`;

const SelectionSchema = Type.Object({ result: Type.Object({ value: Type.String() }) });
const HandleSchema = Type.Object({
  result: Type.Object({ objectId: Type.Optional(Type.String()) }),
});
const FrameOwnerSchema = Type.Object({ node: Type.Object({ frameId: Type.String() }) });
const TargetsSchema = Type.Object({
  targetInfos: Type.Array(Type.Object({ targetId: Type.String() })),
});
const AttachedSchema = Type.Object({ sessionId: Type.String() });
const WorldSchema = Type.Object({ executionContextId: Type.Integer() });

interface Place {
  readonly sessionId: string;
  readonly contextId?: number;
}

function evaluate(
  cdp: Cdp,
  { sessionId, contextId }: Place,
  expression: string,
  returnByValue: boolean,
): Promise<unknown> {
  return cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue, ...(contextId === undefined ? {} : { contextId }) },
    { sessionId },
  );
}

async function unreachableFrame(cdp: Cdp, place: Place): Promise<string | undefined> {
  const { result } = parseCdp(
    HandleSchema,
    await evaluate(cdp, place, UNREACHABLE_FRAME, false),
    "the focused frame",
  );
  const { objectId } = result;
  if (objectId === undefined) return undefined;
  try {
    const { node } = parseCdp(
      FrameOwnerSchema,
      await cdp.send("DOM.describeNode", { objectId }, { sessionId: place.sessionId }),
      "the focused frame's element",
    );
    return node.frameId;
  } finally {
    await cdp
      .send("Runtime.releaseObject", { objectId }, { sessionId: place.sessionId })
      .catch(() => undefined);
  }
}

async function selectionInFrame(cdp: Cdp, place: Place, frameId: string): Promise<string> {
  const { targetInfos } = parseCdp(
    TargetsSchema,
    await cdp.send("Target.getTargets"),
    "the browser's targets",
  );
  if (!targetInfos.some((target) => target.targetId === frameId)) {
    const world = parseCdp(
      WorldSchema,
      await cdp.send(
        "Page.createIsolatedWorld",
        { frameId, worldName: WORLD },
        { sessionId: place.sessionId },
      ),
      "the frame's world",
    );
    return selectionIn(cdp, { sessionId: place.sessionId, contextId: world.executionContextId });
  }
  const { sessionId } = parseCdp(
    AttachedSchema,
    await cdp.send("Target.attachToTarget", { targetId: frameId, flatten: true }),
    "the frame's session",
  );
  try {
    return await selectionIn(cdp, { sessionId });
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

async function selectionIn(cdp: Cdp, place: Place): Promise<string> {
  const frameId = await unreachableFrame(cdp, place);
  if (frameId !== undefined) return selectionInFrame(cdp, place, frameId);
  const { result } = parseCdp(
    SelectionSchema,
    await evaluate(cdp, place, SELECTION, true),
    "the page's selection",
  );
  return result.value;
}

export async function readSelection(cdp: Cdp, sessionId: string): Promise<string> {
  const text = await selectionIn(cdp, { sessionId });
  if (text.length > COPY_LIMIT)
    throw new Error(
      `the selection is ${String(text.length)} characters, more than the ${String(COPY_LIMIT)} that can be copied`,
    );
  return text;
}
