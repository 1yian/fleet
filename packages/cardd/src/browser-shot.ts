import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { call, summary, type Page } from "./browser-page.ts";

const MASK_GROUP = "fleet-mask";

const MASK = `(secrets) => {
  const props = ["-webkit-text-fill-color", "color", "caret-color", "text-shadow"];
  const covered = (el) =>
    el.__fleetFilled === true ||
    (el.value !== "" && secrets.some((secret) => secret !== "" && el.value.includes(secret)));
  const saved = [];
  for (const el of document.querySelectorAll("input, textarea")) {
    if (!covered(el)) continue;
    saved.push([el, props.map((name) => [name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)])]);
    for (const name of props) el.style.setProperty(name, name === "text-shadow" ? "none" : "transparent", "important");
  }
  return saved;
}`;

const UNMASK = `function () {
  for (const [el, saved] of this) {
    for (const [name, value, priority] of saved) {
      if (value === "") el.style.removeProperty(name);
      else el.style.setProperty(name, value, priority);
    }
  }
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
