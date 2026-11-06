import type { OpResult } from "@fleet/protocol";
import { scrubbedOrHidden } from "./browser-hidden.ts";

export const copyAnswer = (
  work: Promise<string>,
  secrets: readonly string[],
): Promise<OpResult<"browser.copy">> =>
  work.then(
    (text) => ({ text, note: null }),
    (error: unknown) => ({
      text: null,
      note: scrubbedOrHidden(error instanceof Error ? error.message : String(error), secrets),
    }),
  );
