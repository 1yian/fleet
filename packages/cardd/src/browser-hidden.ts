const HIDDEN = "[hidden]";

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
    const spelled = REFERENCES[char];
    return spelled === undefined
      ? literal(char)
      : `(?:${[char, ...spelled].map(literal).join("|")})`;
  }).join("");
}

const jsonInner = (text: string): string => JSON.stringify(text).slice(1, -1);

function formsOf(secret: string): string[] {
  const component = encodeURIComponent(secret);
  const form = component.replace(/[!'()~]/g, escapedByte).replaceAll("%20", "+");
  const escaped = jsonInner(secret);
  return [secret, escaped, jsonInner(escaped), component, component.replaceAll("%20", "+"), form];
}

function cleaner(secrets: Iterable<string>): (text: string) => string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (secret === "") continue;
    for (const form of formsOf(secret)) needles.add(form);
  }
  if (needles.size === 0) return (text) => text;
  const pattern = new RegExp(
    [...needles]
      .sort((a, b) => b.length - a.length)
      .map(markup)
      .join("|"),
    "g",
  );
  return (text) => text.replace(pattern, HIDDEN);
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
