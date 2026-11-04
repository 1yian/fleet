import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { call, summary, type Page } from "./browser-page.ts";

const MASK_GROUP = "fleet-mask";

const MASK = `(secrets) => {
  const ordered = secrets.filter((secret) => secret !== "").sort((a, b) => b.length - a.length);
  const blank = (text) => ordered.reduce((out, secret) => out.split(secret).join("\u2022".repeat(secret.length)), text);
  const props = ["-webkit-text-fill-color", "color", "caret-color", "text-shadow"];
  const covered = (el) =>
    el.__fleetFilled === true ||
    (el.value !== "" && ordered.some((secret) => el.value.includes(secret)));
  const undo = [];
  for (const el of document.querySelectorAll("input, textarea")) {
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
  for (const el of document.querySelectorAll("[placeholder], [alt]")) {
    for (const name of ["placeholder", "alt"]) {
      const before = el.getAttribute(name);
      if (before === null || blank(before) === before) continue;
      undo.push(() => el.setAttribute(name, before));
      el.setAttribute(name, blank(before));
    }
  }
  const skipped = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TITLE"];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const before = node.nodeValue ?? "";
    if (skipped.includes(node.parentElement?.tagName ?? "") || blank(before) === before) continue;
    undo.push(() => { node.nodeValue = before; });
    node.nodeValue = blank(before);
  }
  return undo;
}`;

const UNMASK = `function () {
  for (const restore of this) restore();
}`;

const MaskedSchema = Type.Object({
  result: Type.Object({ objectId: Type.String() }),
  exceptionDetails: Type.Optional(Type.Unknown()),
});
const ShotSchema = Type.Object({ data: Type.String() });

async function mask(page: Page, secrets: readonly string[]): Promise<string> {
  const done = parseCdp(
    MaskedSchema,
    await call(page, "Runtime.evaluate", {
      expression: `(${MASK})(${JSON.stringify(secrets)})`,
      objectGroup: MASK_GROUP,
    }),
    "the fields to hide",
  );
  if (done.exceptionDetails !== undefined)
    throw new Error(
      "the fields that hold hidden values could not be covered, so no picture was taken",
    );
  return done.result.objectId;
}

async function unmask(page: Page, objectId: string): Promise<void> {
  await call(page, "Runtime.callFunctionOn", { objectId, functionDeclaration: UNMASK });
  await call(page, "Runtime.releaseObjectGroup", { objectGroup: MASK_GROUP });
}

export async function screenshot(
  page: Page,
  fullPage: boolean,
  secrets: readonly string[],
): Promise<{ text: string; image: { mimeType: string; data: string } }> {
  const covered = await mask(page, secrets);
  try {
    const shot = parseCdp(
      ShotSchema,
      await call(page, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: fullPage,
      }),
      "a screenshot",
    );
    return {
      text: `Screenshot of ${await summary(page)}.`,
      image: { mimeType: "image/png", data: shot.data },
    };
  } finally {
    await unmask(page, covered).catch(() => undefined);
  }
}
