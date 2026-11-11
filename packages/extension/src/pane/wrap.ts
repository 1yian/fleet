import {
  replaceControlCharacters,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const NUMBER_MARKER = /^\d{1,2}\.\s+/;

export const plain = (text: string): string =>
  replaceControlCharacters(stripTerminalSequences(text));

export function hanging(text: string, width: number, first: string, rest: string): string[] {
  const room = Math.max(1, width - visibleWidth(first));
  const rows = wrapTextWithAnsi(text, room);
  return (rows.length === 0 ? [""] : rows).map((row, at) => `${at === 0 ? first : rest}${row}`);
}

export function paragraphs(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => {
    const clean = plain(line).trimEnd();
    if (clean === "") return [""];
    const marker = NUMBER_MARKER.exec(clean)?.[0] ?? "";
    return hanging(clean.slice(marker.length), width, marker, " ".repeat(marker.length));
  });
}

export function packed(pieces: readonly string[], width: number, gap: string): string[] {
  const rows: string[] = [];
  let row = "";
  for (const piece of pieces) {
    const joined = row === "" ? piece : `${row}${gap}${piece}`;
    if (row !== "" && visibleWidth(joined) > width) {
      rows.push(row);
      row = piece;
    } else row = joined;
  }
  return row === "" ? rows : [...rows, row];
}
