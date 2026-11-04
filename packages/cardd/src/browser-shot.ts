import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { Coverage } from "./browser-cover.ts";
import { call, summary, type Page } from "./browser-page.ts";

const ShotSchema = Type.Object({ data: Type.String() });

export async function screenshot(
  page: Page,
  fullPage: boolean,
  secrets: readonly string[],
): Promise<{ text: string; image: { mimeType: string; data: string } }> {
  const coverage = new Coverage(page, secrets);
  try {
    await coverage.begin(fullPage);
    const shot = parseCdp(
      ShotSchema,
      await call(page, "Page.captureScreenshot", { format: "png" }),
      "a screenshot",
    );
    await coverage.verify();
    return {
      text: `Screenshot of ${await summary(page)}.`,
      image: { mimeType: "image/png", data: shot.data },
    };
  } finally {
    await coverage.lift();
  }
}
