import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

export function messageRule(sender: string | undefined, width: number): string {
  const head = truncateToWidth(sender === undefined ? "" : `── ${sender} `, Math.max(width, 0), "");
  return head + "─".repeat(Math.max(width - head.length, 0));
}

export function setApart(body: readonly string[], rule: string): string[] {
  const [first, ...rest] = body;
  if (first === undefined) return [];
  if (stripTerminalSequences(first) === "") return [first, rule, ...rest];
  return [rule, ...body];
}
