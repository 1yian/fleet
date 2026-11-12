const KEPT = 2000;
const UNPLACED = "";

export class Requests {
  private readonly keys = new Map<string, Set<string>>();
  private readonly flooded = new Set<string>();

  taint(page: string, keys: readonly string[]): void {
    if (this.flooded.has(page)) return;
    const held = this.keys.get(page) ?? new Set<string>();
    for (const key of keys) held.add(key);
    for (const oldest of held) {
      if (held.size <= KEPT) break;
      if (page !== UNPLACED) {
        this.keys.delete(page);
        this.flooded.add(page);
        return;
      }
      held.delete(oldest);
    }
    this.keys.set(page, held);
  }

  has(page: string, key: string): boolean {
    if (this.keys.get(UNPLACED)?.has(key) === true) return true;
    if (page === UNPLACED)
      return this.flooded.size > 0 || [...this.keys.values()].some((x) => x.has(key));
    return this.flooded.has(page) || this.keys.get(page)?.has(key) === true;
  }

  forget(page: string): void {
    this.keys.delete(page);
    this.flooded.delete(page);
  }
}
