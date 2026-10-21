import { piecesOf } from "./text.ts";

export function Rich({ text, links = true }: { readonly text: string; readonly links?: boolean }) {
  return (
    <>
      {piecesOf(text).map((piece, index) => {
        if (piece.kind === "text" || !links) return piece.text;
        if (piece.kind === "card")
          return (
            <a key={index} className="ref" href={`#/c-${String(piece.card)}`}>
              {piece.text}
            </a>
          );
        return (
          <a key={index} className="ref" href={piece.href} target="_blank" rel="noreferrer">
            {piece.text}
          </a>
        );
      })}
    </>
  );
}
