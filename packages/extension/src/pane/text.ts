import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { plain } from "./look.ts";

const PASTE_START = "\u001b[200~";

export const oneLine = (data: string): string =>
  data.includes(PASTE_START) ? data.replace(/\s*[\r\n]+\s*/g, " ") : data;

export function paragraphs(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => {
    const clean = plain(line).trimEnd();
    return clean === "" ? [""] : wrapTextWithAnsi(clean, width);
  });
}
