export const EMAIL_ADDRESS =
  /(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|(?<![\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]+)@(?:[\p{L}\p{M}\p{N}-]+[.。．｡])+[\p{L}][\p{L}\p{M}\p{N}-]*/gu;

const SERIALIZED_ESCAPE = /\\(u[\da-fA-F]{4}|U[\da-fA-F]{8}|x[\da-fA-F]{2}|["/\\bfnrt])/g;
const ESCAPE_VALUES: Readonly<Record<string, string>> = {
  '"': '"',
  "/": "/",
  "\\": "\\",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const EMAIL_WITHHELD = "[email withheld: serialized address]";

function decodedEscape(raw: string, code: string): string {
  if (code.length === 1) return ESCAPE_VALUES[code] ?? raw;
  const point = Number.parseInt(code.slice(1), 16);
  return point <= 0x10ffff ? String.fromCodePoint(point) : raw;
}

export function withholdSerializedEmail(text: string): string {
  let view = text;
  for (let depth = 0; depth < 8; depth += 1) {
    const decoded = view.replace(SERIALIZED_ESCAPE, decodedEscape);
    if (decoded === view) return text;
    if (decoded.search(EMAIL_ADDRESS) !== -1) return EMAIL_WITHHELD;
    view = decoded;
  }
  return view.replace(SERIALIZED_ESCAPE, decodedEscape) === view ? text : EMAIL_WITHHELD;
}
