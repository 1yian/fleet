export const CAPTAIN = "captain";

export function howToReply(to: "worker" | "mate", card: number, id: string, from = ""): string {
  const on = `card=${String(card)}`;
  if (to === "worker") return `answer with report(status, text, replyTo="${id}")`;
  const how = `comment(${on}, text, replyTo="${id}") or hold(${on}, question, replyTo="${id}")`;
  return from === CAPTAIN ? `answer the captain on the board with ${how}` : `answer with ${how}`;
}
