const HIDDEN = "[hidden]";

const escapedByte = (char: string): string => `%${char.charCodeAt(0).toString(16).toUpperCase()}`;

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function formsOf(secret: string): string[] {
  const component = encodeURIComponent(secret);
  const form = component.replace(/[!'()~]/g, escapedByte).replaceAll("%20", "+");
  return [
    secret,
    JSON.stringify(secret).slice(1, -1),
    component,
    component.replaceAll("%20", "+"),
    form,
  ];
}

export function scrubbed(text: string, secrets: Iterable<string>): string {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (secret === "") continue;
    for (const form of formsOf(secret)) needles.add(form);
  }
  if (needles.size === 0) return text;
  const pattern = [...needles]
    .sort((a, b) => b.length - a.length)
    .map(literal)
    .join("|");
  return text.replace(new RegExp(pattern, "g"), HIDDEN);
}
