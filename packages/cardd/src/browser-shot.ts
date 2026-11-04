import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { coverPage, liftCover, newCover } from "./browser-cover.ts";
import { call, summary, type Page } from "./browser-page.ts";

const ShotSchema = Type.Object({ data: Type.String() });

export async function screenshot(
  page: Page,
  fullPage: boolean,
  secrets: readonly string[],
): Promise<{ text: string; image: { mimeType: string; data: string } }> {
  const cover = newCover();
  try {
    await coverPage(cover, page, secrets);
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
    await liftCover(cover);
  }
}
