import type { Page } from "./browser-page.ts";
import { holdsPassword, type Suspicion } from "./browser-scan.ts";

export class Entered {
  private readonly marked = new Set<string>();
  private readonly assumed = new Set<string>();
  private readonly passwords = new Set<string>();

  has(target: string): boolean {
    return this.marked.has(target);
  }

  mark(target: string, assumed = false): void {
    this.marked.add(target);
    if (assumed) this.assumed.add(target);
  }

  forget(target: string): void {
    this.marked.delete(target);
    this.assumed.delete(target);
  }

  holds(
    page: Page,
    target: string,
    suspicion: Suspicion = this.assumed.has(target) ? "blind" : "none",
  ): Promise<boolean> {
    return holdsPassword(page, this.passwords, suspicion);
  }
}
