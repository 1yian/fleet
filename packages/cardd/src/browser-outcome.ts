import type { OpResult } from "@fleet/protocol";
import { scrubbed } from "./browser-hidden.ts";
import { cut, summary, type Page } from "./browser-page.ts";

export interface Outcome {
  readonly result: OpResult<"browser">;
  readonly notify: readonly string[];
  readonly captain?: string;
}

export const plain = (text: string): Outcome => ({ result: { text }, notify: [] });

export async function atPage(page: Page, text: string): Promise<Outcome> {
  const where = await summary(page).catch(() => undefined);
  return { result: { text, ...(where === undefined ? {} : { page: where }) }, notify: [] };
}

export function guarded(work: Promise<Outcome>, secrets: readonly string[]): Promise<Outcome> {
  return work.then(
    (done) => ({
      notify: done.notify,
      ...(done.captain === undefined ? {} : { captain: done.captain }),
      result: {
        ...done.result,
        text: cut(scrubbed(done.result.text, secrets)),
        ...(done.result.page === undefined ? {} : { page: scrubbed(done.result.page, secrets) }),
      },
    }),
    (error: unknown) => {
      throw new Error(scrubbed(error instanceof Error ? error.message : String(error), secrets));
    },
  );
}
