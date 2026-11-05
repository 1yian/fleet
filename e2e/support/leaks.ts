import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function filesUnder(root: string, skip: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    if (skip(name)) continue;
    const path = join(root, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) found.push(...filesUnder(path, skip));
    else if (info.isFile()) found.push(path);
  }
  return found;
}

const TABLES: readonly Readonly<Record<string, string>>[] = [
  { "&": "&amp;", "<": "&lt;", ">": "&gt;" },
  { "&": "&amp;", '"': "&quot;" },
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" },
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" },
  { "&": "&#38;", "<": "&#60;", ">": "&#62;", '"': "&#34;", "'": "&#39;" },
  { "&": "&#x26;", "<": "&#x3c;", ">": "&#x3e;", '"': "&#x22;", "'": "&#x27;" },
];

const spelled = (text: string, table: Readonly<Record<string, string>>): string =>
  text.replace(/[&<>"']/g, (char) => table[char] ?? char);

export function formsOf(secret: string): string[] {
  const encoded = encodeURIComponent(secret);
  const layers = [secret];
  for (let depth = 0; depth < 5; depth += 1)
    layers.push(JSON.stringify(layers[depth]).slice(1, -1));
  const markup = TABLES.flatMap((table) => [
    spelled(secret, table),
    spelled(layers[1] ?? "", table),
  ]);
  return [...layers, ...markup, encoded, encoded.replaceAll("%20", "+")];
}

export function filesHolding(
  secrets: readonly string[],
  root: string,
  skip: (name: string) => boolean = () => false,
): string[] {
  return filesUnder(root, skip).filter((file) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return false;
    }
    return secrets.some((secret) => formsOf(secret).some((form) => bytes.includes(form)));
  });
}
