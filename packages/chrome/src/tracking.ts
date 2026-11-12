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

const LOAD_FORCE_MS = 10_000;

export class Loads {
  private readonly generations = new Map<string, number>();
  private readonly since = new Map<string, number>();
  private readonly awaiting = new Map<string, Set<string>>();

  mark(session: string): void {
    if (!this.since.has(session)) this.since.set(session, Date.now());
  }

  invalidate(session: string): void {
    this.generations.set(session, this.generation(session) + 1);
    this.mark(session);
  }

  begin(session: string, frame: string): void {
    this.invalidate(session);
    this.since.set(session, Date.now());
    const frames = this.awaiting.get(session) ?? new Set<string>();
    frames.add(frame);
    this.awaiting.set(session, frames);
  }

  parsed(session: string, frame: string): void {
    this.awaiting.get(session)?.delete(frame);
  }

  generation(session: string): number {
    return this.generations.get(session) ?? 0;
  }

  waiting(session: string): boolean {
    return (this.awaiting.get(session)?.size ?? 0) > 0;
  }

  overdue(session: string): boolean {
    const started = this.since.get(session);
    return started !== undefined && Date.now() - started >= LOAD_FORCE_MS;
  }

  done(session: string): void {
    this.since.delete(session);
    this.awaiting.delete(session);
  }

  forget(session: string): void {
    this.done(session);
    this.generations.delete(session);
  }

  clear(): void {
    this.generations.clear();
    this.since.clear();
    this.awaiting.clear();
  }
}
