export type Piece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string }
  | { readonly kind: "card"; readonly text: string; readonly card: number };

const TOKEN = /(https?:\/\/[^\s<>"“”]+)|(?<![\w/.-])c-(\d+)(?![\w-])/g;
const TRAILING = /[.,;:!?'”’]+$/;

export const idLabel = (card: number): string => `#${String(card)}`;

function linkEnd(url: string): { url: string; rest: string } {
  let end = url;
  let rest = "";
  for (;;) {
    const trimmed = end.replace(TRAILING, "");
    const open = (trimmed.match(/\(/g) ?? []).length;
    const close = (trimmed.match(/\)/g) ?? []).length;
    const unmatched = trimmed.endsWith(")") && close > open ? trimmed.slice(0, -1) : trimmed;
    if (unmatched === end) return { url: end, rest };
    rest = end.slice(unmatched.length) + rest;
    end = unmatched;
  }
}

export function piecesOf(text: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [whole, url, card] = match;
    if (match.index > at) pieces.push({ kind: "text", text: text.slice(at, match.index) });
    if (url !== undefined) {
      const { url: href, rest } = linkEnd(url);
      pieces.push({ kind: "link", text: href, href });
      if (rest !== "") pieces.push({ kind: "text", text: rest });
    } else if (card !== undefined) {
      pieces.push({ kind: "card", text: idLabel(Number(card)), card: Number(card) });
    }
    at = match.index + whole.length;
  }
  if (at < text.length) pieces.push({ kind: "text", text: text.slice(at) });
  return pieces;
}
