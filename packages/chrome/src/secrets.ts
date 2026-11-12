const SECRETS_KEPT = 2000;

export class Secrets {
  private readonly ids = new Map<string, Set<string>>();
  private readonly flooded = new Set<string>();

  keep(session: string, id: string): void {
    if (this.flooded.has(session)) return;
    const ids = this.ids.get(session) ?? new Set<string>();
    if (ids.size >= SECRETS_KEPT) {
      this.ids.delete(session);
      this.flooded.add(session);
      return;
    }
    ids.add(id);
    this.ids.set(session, ids);
  }

  has(session: string, id: string): boolean {
    return this.flooded.has(session) || this.ids.get(session)?.has(id) === true;
  }

  forget(session: string): void {
    this.ids.delete(session);
    this.flooded.delete(session);
  }
}
