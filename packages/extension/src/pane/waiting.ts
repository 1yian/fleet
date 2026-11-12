import type { BoardCard } from "@fleet/protocol";
import type { Link } from "../link.ts";
import { decisionsOf, type Decision } from "./decisions.ts";

const DEADLINE_MS = 10_000;

export interface Waits {
  readonly cards: readonly BoardCard[];
  readonly decisions: readonly Decision[];
}

export class Waiting {
  private flying: Promise<Waits> | undefined;
  private following: Promise<Waits> | undefined;
  private newest: Waits | undefined;
  private readonly listeners = new Set<(waits: Waits) => void>();
  private readonly link: Link;

  constructor(link: Link) {
    this.link = link;
  }

  get latest(): Waits | undefined {
    return this.newest;
  }

  follow(listener: (waits: Waits) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  read(): Promise<Waits> {
    if (this.flying === undefined) return this.start();
    this.following ??= this.flying
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.following = undefined;
        return this.start();
      });
    return this.following;
  }

  private start(): Promise<Waits> {
    const reading = this.fetch();
    this.flying = reading;
    const finish = (): void => {
      if (this.flying === reading) this.flying = undefined;
    };
    reading.then(finish, finish);
    return reading;
  }

  private async fetch(): Promise<Waits> {
    const board = await this.link.call("board", {}, DEADLINE_MS);
    const waits = await decisionsOf(this.link, board);
    this.newest = waits;
    for (const listener of this.listeners) listener(waits);
    return waits;
  }
}
