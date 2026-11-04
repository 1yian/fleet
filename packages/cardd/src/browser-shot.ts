import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { CREDENTIAL_SHOWN, showsCredential } from "./browser-scan.ts";
import { call, summary, type Page } from "./browser-page.ts";

const ShotSchema = Type.Object({ data: Type.String() });
const LayoutSchema = Type.Object({
  cssContentSize: Type.Object({ width: Type.Number(), height: Type.Number() }),
});

const MAX_HEIGHT = 16_384;

async function params(page: Page, fullPage: boolean): Promise<object> {
  if (!fullPage) return { format: "png" };
  const { cssContentSize } = parseCdp(
    LayoutSchema,
    await call(page, "Page.getLayoutMetrics"),
    "the page's size",
  );
  return {
    format: "png",
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.ceil(cssContentSize.width),
      height: Math.min(Math.ceil(cssContentSize.height), MAX_HEIGHT),
      scale: 1,
    },
  };
}

export async function screenshot(
  page: Page,
  fullPage: boolean,
  secrets: readonly string[],
): Promise<{ text: string; image: { mimeType: string; data: string } }> {
  if (await showsCredential(page, secrets)) throw new Error(CREDENTIAL_SHOWN);
  const shot = parseCdp(
    ShotSchema,
    await call(page, "Page.captureScreenshot", await params(page, fullPage)),
    "a screenshot",
  );
  return {
    text: `Screenshot of ${await summary(page)}.`,
    image: { mimeType: "image/png", data: shot.data },
  };
}
