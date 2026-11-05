import Type from "typebox";
import { parseCdp, type Cdp } from "./cdp.ts";

const COPY_LIMIT = 1_000_000;

const SELECTION = `(() => {
  const focused = (doc) => {
    let element = doc.activeElement;
    while (element !== null && element.shadowRoot !== null && element.shadowRoot.activeElement !== null)
      element = element.shadowRoot.activeElement;
    return element;
  };
  const docs = [document];
  for (;;) {
    const element = focused(docs[docs.length - 1]);
    let inner = null;
    try {
      inner = element !== null && element.tagName === "IFRAME" ? element.contentDocument : null;
    } catch {
      inner = null;
    }
    if (inner === null) break;
    docs.push(inner);
  }
  for (const doc of docs.reverse()) {
    const field = focused(doc);
    try {
      if (field !== null && field.tagName === "INPUT" && field.type === "password" && field.selectionStart !== field.selectionEnd)
        return "";
    } catch {
      return "";
    }
    const text = doc.getSelection().toString();
    if (text !== "") return text;
  }
  return "";
})()`;

const SelectionSchema = Type.Object({ result: Type.Object({ value: Type.String() }) });

export async function readSelection(cdp: Cdp, sessionId: string): Promise<string> {
  const { result } = parseCdp(
    SelectionSchema,
    await cdp.send(
      "Runtime.evaluate",
      { expression: SELECTION, returnByValue: true },
      { sessionId },
    ),
    "the page's selection",
  );
  if (result.value.length > COPY_LIMIT)
    throw new Error(
      `the selection is ${String(result.value.length)} characters, more than the ${String(COPY_LIMIT)} that can be copied`,
    );
  return result.value;
}
