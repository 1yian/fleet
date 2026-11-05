import { ENTITIES, windows1252 } from "./browser-entities.ts";

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

const OPEN = "\u0000";
const CLOSE = "\u0001";
const BETWEEN = `[${OPEN}${CLOSE}]*`;

const isMarked = (text: string): boolean => text.includes(OPEN) || text.includes(CLOSE);

const unmarked = (text: string): string => text.replaceAll(OPEN, "").replaceAll(CLOSE, "");

function pieces(text: string): string[] {
  return Array.from(text, (char) => {
    if (/\s/.test(char)) return "\\s+";
    const spelled = REFERENCES[char];
    return spelled === undefined
      ? literal(char)
      : `(?:${[char, ...spelled].map(literal).join("|")})`;
  });
}

const SCRUBBABLE = new Set(Object.values(REFERENCES).flat());

const TAG = /<!--[\s\S]*?-->|<[/!?]?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
const REFERENCE = /&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g;

function codePoint(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
  return windows1252(code) ?? String.fromCodePoint(code);
}

function named(name: string, semicolon: string): string | undefined {
  const exact = semicolon === ";" ? ENTITIES.get(`${name};`) : undefined;
  if (exact !== undefined) return exact;
  for (let size = name.length; size >= 2; size -= 1) {
    const chars = ENTITIES.get(name.slice(0, size));
    if (chars !== undefined) return `${chars}${name.slice(size)}${semicolon}`;
  }
  return undefined;
}

function decoded(
  decimal?: string,
  hex?: string,
  name?: string,
  semicolon?: string,
): string | undefined {
  if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10));
  if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
  return named(name ?? "", semicolon ?? "");
}

function compose(text: string, strip: boolean): string {
  return (strip ? text.replace(TAG, `${OPEN}${CLOSE}`) : text).replace(
    REFERENCE,
    (all: string, decimal?: string, hex?: string, name?: string, semicolon?: string) => {
      const chars = decoded(decimal, hex, name, semicolon);
      if (chars === undefined) return all;
      return SCRUBBABLE.has(all.toLowerCase()) ? chars : `${OPEN}${chars}${CLOSE}`;
    },
  );
}

const viewsOf = (text: string): string[] => [compose(text, true), compose(text, false)];

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

const longestFirst = (needles: readonly string[]): string[] =>
  [...needles].sort((a, b) => b.length - a.length);

function patternOf(needles: readonly string[], flags: string): RegExp {
  return new RegExp(
    longestFirst(needles)
      .map((needle) => pieces(needle).join(""))
      .join("|"),
    flags,
  );
}

function spanningOf(needles: readonly string[]): RegExp {
  const alternatives = longestFirst(needles).map((needle) => pieces(needle).join(BETWEEN));
  return new RegExp(`(?=(${OPEN}*(?:${alternatives.join("|")})${CLOSE}*))`, "gi");
}

function cleaner(secrets: Iterable<string>): (text: string) => string {
  const needles = needlesOf(secrets);
  if (needles.length === 0) return (text) => text;
  const replace = patternOf(needles, "gi");
  const find = patternOf(needles, "i");
  const spanning = spanningOf(needles);
  const composed = (view: string): boolean =>
    find.test(unmarked(view)) &&
    [...view.matchAll(spanning)].some((found) => isMarked(found[1] ?? ""));
  return (text) => {
    if (viewsOf(text).some(composed)) throw new Error(REFUSED_OUTPUT);
    return text.replace(replace, HIDDEN);
  };
}

export function exposure(secrets: Iterable<string>): (text: string) => boolean {
  const needles = needlesOf(secrets);
  if (needles.length === 0) return () => false;
  const find = patternOf(needles, "i");
  return (text) => find.test(text) || viewsOf(text).some((view) => find.test(unmarked(view)));
}

export const scrubbed = (text: string, secrets: Iterable<string>): string => cleaner(secrets)(text);

export function scrubbedOrHidden(text: string, secrets: Iterable<string>): string {
  try {
    return scrubbed(text, secrets);
  } catch {
    return HIDDEN;
  }
}

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
