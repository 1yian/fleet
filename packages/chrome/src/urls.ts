const MARKS_KEPT = 64;
const MARK_CHARS = 8192;
const BARE_CHARS = 8;
const ANY_ADDRESS = /(https?:\/\/[^"\\\s?#]+)[?#][^"\\\s]*/g;

const escaped = (value: string): string => JSON.stringify(value).slice(1, -1);
const pattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripped = (value: string): string => value.replace(/[?#][\s\S]*$/, "");
const unscheme = (value: string): string => value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");

function forms(url: string): string[] {
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash);
  const query = base.indexOf("?");
  const bare = [query < 0 ? "" : base.slice(query), hash < 0 ? "" : url.slice(hash)];
  return [url, base, unscheme(url), unscheme(base), ...bare.filter((x) => x.length >= BARE_CHARS)];
}

export class Addresses {
  private readonly marked = new Map<string, Set<string>>();
  private readonly flooded = new Set<string>();
  private rewrites = new Map<string, string>();
  private matcher: RegExp | undefined;

  mark(page: string, url: string): void {
    if (!/[?#]/.test(url) || this.flooded.has(page)) return;
    const urls = this.marked.get(page) ?? new Set<string>();
    if (urls.size >= MARKS_KEPT || url.length > MARK_CHARS) {
      this.marked.delete(page);
      this.flooded.add(page);
    } else {
      urls.add(url);
      this.marked.set(page, urls);
    }
    this.rebuild();
  }

  forget(page: string): void {
    this.marked.delete(page);
    this.flooded.delete(page);
    this.rebuild();
  }

  keepOnly(pages: ReadonlySet<string>): void {
    for (const page of [...this.marked.keys(), ...this.flooded])
      if (page !== "" && !pages.has(page)) this.forget(page);
  }

  scrub(text: string): string {
    const rewritten =
      this.matcher === undefined
        ? text
        : text.replace(this.matcher, (found) => this.rewrites.get(found) ?? found);
    return this.flooded.size === 0 ? rewritten : rewritten.replace(ANY_ADDRESS, "$1");
  }

  private rebuild(): void {
    const rewrites = new Map<string, string>();
    for (const urls of this.marked.values())
      for (const url of urls)
        for (const form of forms(url)) rewrites.set(escaped(form), escaped(stripped(form)));
    this.rewrites = rewrites;
    const found = [...rewrites.keys()].sort((a, b) => b.length - a.length);
    this.matcher = found.length === 0 ? undefined : new RegExp(found.map(pattern).join("|"), "g");
  }
}
