const HIDDEN = "[hidden]";

const REFUSED_OUTPUT = "this output contains a stored credential; read it as text, which hides it";

const escapedByte = (char: string): string => `%${char.charCodeAt(0).toString(16).toUpperCase()}`;

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const REFERENCES: Readonly<Record<string, readonly string[]>> = {
  "&": ["&amp;", "&#38;", "&#x26;"],
  "<": ["&lt;", "&#60;", "&#x3c;", "&#x3C;"],
  ">": ["&gt;", "&#62;", "&#x3e;", "&#x3E;"],
  '"': ["&quot;", "&#34;", "&#x22;"],
  "'": ["&#39;", "&#x27;", "&apos;"],
};

function markup(text: string): string {
  return Array.from(text, (char) => {
    if (/\s/.test(char)) return "\\s+";
    const spelled = REFERENCES[char];
    return spelled === undefined
      ? literal(char)
      : `(?:${[char, ...spelled].map(literal).join("|")})`;
  }).join("");
}

const NAMED: Readonly<Record<string, string>> = {
  Tab: "\t",
  NewLine: "\n",
  nbsp: "\u00a0",
  excl: "!",
  quot: '"',
  QUOT: '"',
  num: "#",
  dollar: "$",
  percnt: "%",
  amp: "&",
  AMP: "&",
  apos: "'",
  lpar: "(",
  rpar: ")",
  ast: "*",
  midast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  lt: "<",
  LT: "<",
  equals: "=",
  gt: ">",
  GT: ">",
  quest: "?",
  commat: "@",
  lsqb: "[",
  lbrack: "[",
  bsol: "\\",
  rsqb: "]",
  rbrack: "]",
  Hat: "^",
  lowbar: "_",
  UnderBar: "_",
  grave: "`",
  DiacriticalGrave: "`",
  lcub: "{",
  lbrace: "{",
  verbar: "|",
  vert: "|",
  VerticalLine: "|",
  rcub: "}",
  rbrace: "}",
};

const TAG = /<!--[\s\S]*?-->|<[/!?]?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
const REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]*));?/g;

function character(all: string, code: number): string {
  return code === 0 || code > 0x10ffff ? all : String.fromCodePoint(code);
}

function composed(text: string): string {
  return text
    .replace(TAG, "")
    .replace(REFERENCE, (all, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return character(all, Number.parseInt(decimal, 10));
      if (hex !== undefined) return character(all, Number.parseInt(hex, 16));
      return NAMED[name ?? ""] ?? all;
    });
}

const jsonInner = (text: string): string => JSON.stringify(text).slice(1, -1);

function formsOf(secret: string): string[] {
  const component = encodeURIComponent(secret);
  const form = component.replace(/[!'()~]/g, escapedByte).replaceAll("%20", "+");
  const escaped = jsonInner(secret);
  return [secret, escaped, jsonInner(escaped), component, component.replaceAll("%20", "+"), form];
}

function needlesOf(secrets: Iterable<string>): string[] {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (secret === "") continue;
    for (const form of formsOf(secret)) needles.add(form);
  }
  return [...needles];
}

function patternOf(needles: readonly string[], flags: string): RegExp {
  return new RegExp(
    [...needles]
      .sort((a, b) => b.length - a.length)
      .map(markup)
      .join("|"),
    flags,
  );
}

function cleaner(secrets: Iterable<string>): (text: string) => string {
  const needles = needlesOf(secrets);
  if (needles.length === 0) return (text) => text;
  const replace = patternOf(needles, "gi");
  const find = patternOf(needles, "i");
  return (text) => {
    const flat = text.replace(replace, HIDDEN);
    if (find.test(composed(flat))) throw new Error(REFUSED_OUTPUT);
    return flat;
  };
}

export function exposure(secrets: Iterable<string>): (text: string) => boolean {
  const needles = needlesOf(secrets);
  if (needles.length === 0) return () => false;
  const find = patternOf(needles, "i");
  return (text) => find.test(text) || find.test(composed(text));
}

export const scrubbed = (text: string, secrets: Iterable<string>): string => cleaner(secrets)(text);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serialized(text: string): { value: unknown } | undefined {
  const first = text.trimStart().charAt(0);
  if (first !== "{" && first !== "[" && first !== '"') return undefined;
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function walk(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === "string") {
    const flat = clean(value);
    const inner = serialized(value);
    if (inner === undefined) return flat;
    const tidy = JSON.stringify(walk(inner.value, clean));
    return tidy === JSON.stringify(inner.value) ? flat : clean(tidy);
  }
  if (Array.isArray(value)) return value.map((each) => walk(each, clean));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [clean(key), walk(each, clean)]),
    );
  return value;
}

export const scrubbedValue = (value: unknown, secrets: Iterable<string>): unknown =>
  walk(value, cleaner(secrets));
