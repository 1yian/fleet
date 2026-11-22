const LOCAL_PART =
  /(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|(?<![\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]+)/u
    .source;
const DOMAIN_NAME = /(?:[\p{L}\p{M}\p{N}-]+[.。．｡])+[\p{L}][\p{L}\p{M}\p{N}-]*/u.source;
const DOMAIN_LITERAL = /\[[^\]\s]+\]/u.source;

export const EMAIL_ADDRESS = new RegExp(`${LOCAL_PART}@${DOMAIN_NAME}`, "gu");
const SERIALIZED_ADDRESS = new RegExp(`${LOCAL_PART}@(?:${DOMAIN_NAME}|${DOMAIN_LITERAL})`, "u");

const SERIALIZED_ESCAPE =
  /\\(u[\da-fA-F]{4}|u\{[\da-fA-F]{1,8}\}|U[\da-fA-F]{8}|x[\da-fA-F]{2}|["/\\bfnrt])/g;
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
  const point = Number.parseInt(code.slice(1).replace(/[{}]/g, ""), 16);
  return point <= 0x10ffff ? String.fromCodePoint(point) : raw;
}

export function withholdSerializedEmail(text: string): string {
  let view = text;
  for (let depth = 0; depth < 8; depth += 1) {
    const decoded = view.replace(SERIALIZED_ESCAPE, decodedEscape);
    if (decoded === view) return text;
    if (SERIALIZED_ADDRESS.test(decoded)) return EMAIL_WITHHELD;
    view = decoded;
  }
  return view.replace(SERIALIZED_ESCAPE, decodedEscape) === view ? text : EMAIL_WITHHELD;
}
