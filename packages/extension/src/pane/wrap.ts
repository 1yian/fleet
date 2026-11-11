import {
  replaceControlCharacters,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const NUMBER_MARKER = /^\d{1,2}\.\s+/;

export const plain = (text: string): string =>
  replaceControlCharacters(stripTerminalSequences(text));

function hanging(text: string, width: number, first: string, rest: string): string[] {
  const room = Math.max(1, width - visibleWidth(first));
  const rows = wrapTextWithAnsi(text, room);
  return (rows.length === 0 ? [""] : rows).map((row, at) => `${at === 0 ? first : rest}${row}`);
}

export function bounded(text: string, width: number, limit: number): string[] {
  const rows = hanging(text, width, "", "");
  if (rows.length <= limit) return rows;
  const last = rows[limit - 1] ?? "";
  return [...rows.slice(0, limit - 1), truncateToWidth(`${last}…`, width, "…")];
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

interface Styles {
  readonly word: (text: string) => string;
  readonly quiet: (text: string) => string;
}

export function optionLines(label: string, room: number, tag: string, style: Styles): string[] {
  const rows = hanging(label, room, "", "");
  const tagged = tag !== "" && visibleWidth(rows.at(-1) ?? "") + visibleWidth(tag) <= room;
  const lines = rows.map((row, index) => {
    const suffix = tagged && index === rows.length - 1 ? style.quiet(tag) : "";
    return `${style.word(row)}${suffix}`;
  });
  return tag === "" || tagged ? lines : [...lines, style.quiet(tag.trimStart())];
}
