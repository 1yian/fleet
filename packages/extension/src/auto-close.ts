import type { Entry } from "@fleet/protocol";
import { close } from "./closing.ts";
import type { Link } from "./link.ts";

export const isMergedReport = (entry: Entry): boolean =>
  entry.kind === "report" && entry.fields["status"] === "merged";

export async function closeMerged(link: Link, entry: Entry): Promise<string> {
  const pr = entry.fields["pr"];
  const summary = `${typeof pr === "string" ? `PR ${pr} merged: ` : ""}${entry.body}`;
  try {
    const done = await close(link, { card: entry.card, text: summary, confirm: true });
    return ` Closed automatically: ${done} Relay the outcome with the PR URL.`;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return ` Closing it automatically failed (${why}). Close it yourself with close(card, summary).`;
  }
}
