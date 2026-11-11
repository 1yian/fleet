import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MOVE_SCRATCH_SCRIPT = readFileSync(
  fileURLToPath(new URL("./move-scratch.sh", import.meta.url)),
  "utf8",
);

export const MOVE_TIMEOUT_MS = 30 * 60_000;

export type Move =
  | {
      readonly kind: "moved";
      readonly source: string;
      readonly dest: string;
      readonly note: string;
    }
  | { readonly kind: "skipped"; readonly source: string; readonly reason: string };

export function parseMove(output: string): Move | undefined {
  const line = output.trim().split("\n").at(-1) ?? "";
  const [kind, source = "", third = "", note = ""] = line.split("\t");
  if (source === "" || third === "") return undefined;
  if (kind === "moved") return { kind, source, dest: third, note };
  if (kind === "skipped") return { kind, source, reason: third };
  return undefined;
}

export function describeMove(move: Move | undefined): string {
  if (move === undefined) return "nothing to move";
  if (move.kind === "skipped") return `${move.source} stays in place: ${move.reason}`;
  const note = move.note === "" ? "" : ` (${move.note})`;
  return `${move.source} moved to ${move.dest}${note}`;
}
