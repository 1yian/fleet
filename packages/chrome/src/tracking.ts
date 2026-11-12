export type Ref =
  | { readonly kind: "page"; readonly id: string }
  | { readonly kind: "other" }
  | { readonly kind: "unknown" };

const UNLISTED = "unlisted";

export class Targets {
  private readonly kinds = new Map<string, string>();
  private readonly frames = new Map<string, string>();

  add(id: string, type: string): void {
    this.kinds.set(id, type);
  }

  unlist(id: string): void {
    if (!this.kinds.has(id)) this.kinds.set(id, UNLISTED);
  }

  frame(id: string, page: string): void {
    this.frames.set(id, page);
  }

  remove(id: string): void {
    this.kinds.delete(id);
    this.frames.delete(id);
  }

  has(id: string): boolean {
    return this.kinds.has(id);
  }

  ref(id: string): Ref {
    const type = this.kinds.get(id);
    if (type === undefined || type === UNLISTED) return { kind: "unknown" };
    if (type === "page") return { kind: "page", id };
    if (type !== "iframe") return { kind: "other" };
    const page = this.frames.get(id);
    return page === undefined ? { kind: "unknown" } : { kind: "page", id: page };
  }

  clear(): void {
    this.kinds.clear();
    this.frames.clear();
  }
}

export class Contexts {
  private readonly typedBy = new Map<string, Map<number, boolean>>();
  private readonly defaultsBy = new Map<string, Set<number>>();

  created(session: string, id: number, isDefault: boolean): void {
    const typed = this.typedBy.get(session) ?? new Map<number, boolean>();
    typed.set(id, typed.get(id) ?? false);
    this.typedBy.set(session, typed);
    if (!isDefault) return;
    const defaults = this.defaultsBy.get(session) ?? new Set<number>();
    defaults.add(id);
    this.defaultsBy.set(session, defaults);
  }

  destroyed(session: string, id: number): void {
    this.typedBy.get(session)?.delete(id);
    this.defaultsBy.get(session)?.delete(id);
  }

  drop(session: string): void {
    this.typedBy.delete(session);
    this.defaultsBy.delete(session);
  }

  bound(session: string, id: number, typed: boolean): void {
    this.typedBy.get(session)?.set(id, typed);
  }

  typed(session: string): boolean {
    return [...(this.typedBy.get(session)?.values() ?? [])].some(Boolean);
  }

  defaults(session: string): number[] {
    return [...(this.defaultsBy.get(session) ?? [])];
  }

  clear(): void {
    this.typedBy.clear();
    this.defaultsBy.clear();
  }
}
