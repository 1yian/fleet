export const REQUESTS_KEPT = 2000;
const UNPLACED = "";

export class Requests {
  private readonly keys = new Map<string, Set<string>>();
  private readonly flooded = new Set<string>();
  private readonly kept: number;

  constructor(kept: number) {
    this.kept = kept;
  }

  taint(page: string, keys: readonly string[]): void {
    if (keys.length === 0 || this.flooded.has(page)) return;
    const held = this.keys.get(page) ?? new Set<string>();
    for (const key of keys) held.add(key);
    if (held.size > this.kept) {
      this.keys.delete(page);
      this.flooded.add(page);
      return;
    }
    this.keys.set(page, held);
  }

  promote(pages: Iterable<string>): void {
    if (!this.flooded.delete(UNPLACED)) return;
    for (const page of pages) {
      this.keys.delete(page);
      this.flooded.add(page);
    }
  }

  has(page: string, key: string): boolean {
    if (this.flooded.has(UNPLACED) || this.keys.get(UNPLACED)?.has(key) === true) return true;
    if (page === UNPLACED)
      return this.flooded.size > 0 || [...this.keys.values()].some((x) => x.has(key));
    return this.flooded.has(page) || this.keys.get(page)?.has(key) === true;
  }

  holds(page: string): boolean {
    const real = (key: string): boolean => !key.startsWith("post:") && !key.startsWith("bare:");
    const some = (held: Set<string> | undefined): boolean => [...(held ?? [])].some(real);
    const unplaced = this.flooded.has(UNPLACED) || some(this.keys.get(UNPLACED));
    if (page === UNPLACED)
      return unplaced || this.flooded.size > 0 || [...this.keys.values()].some((x) => some(x));
    return unplaced || this.flooded.has(page) || some(this.keys.get(page));
  }

  forget(page: string): void {
    this.keys.delete(page);
    this.flooded.delete(page);
  }
}
