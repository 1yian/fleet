import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

export const PROMPT = "FIRST-QUESTION-OF-THE-LONG-CONVERSATION";
export const OLDEST = "OLDEST-WORDS-OF-THE-LONG-CONVERSATION";
export const NEWEST = "NEWEST-WORDS-OF-THE-LONG-CONVERSATION";

export const TURN_WORDS = "Checked the board, turn ";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const entryId = (): string => randomBytes(4).toString("hex");

export function writeLongSession(file: string, cwd: string, turns: number): void {
  const at = Date.parse("2026-10-20T16:49:00.000Z");
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: randomBytes(16).toString("hex"),
      timestamp: new Date(at).toISOString(),
      cwd,
    }),
  ];
  let parent: string | null = null;
  const append = (entry: Record<string, unknown>, when: number): void => {
    const id = entryId();
    lines.push(
      JSON.stringify({ ...entry, id, parentId: parent, timestamp: new Date(when).toISOString() }),
    );
    parent = id;
  };
  append(
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: PROMPT }], timestamp: at },
    },
    at,
  );
  for (let turn = 0; turn < turns; turn++) {
    const when = at + (turn + 1) * 1000;
    const words = turn === 0 ? OLDEST : `${TURN_WORDS}${String(turn)}.`;
    const call = `call-${String(turn)}`;
    append(
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: words },
            { type: "toolCall", id: call, name: "board", arguments: {} },
          ],
          api: "fake",
          provider: "fake",
          model: "scripted",
          usage: ZERO_USAGE,
          stopReason: "toolUse",
          timestamp: when,
        },
      },
      when,
    );
    append(
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: call,
          toolName: "board",
          content: [{ type: "text", text: `c-${String(turn)} [working] a card on the board` }],
          details: {},
          isError: false,
          timestamp: when,
        },
      },
      when,
    );
  }
  const end = at + (turns + 1) * 1000;
  append(
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: NEWEST }],
        api: "fake",
        provider: "fake",
        model: "scripted",
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: end,
      },
    },
    end,
  );
  writeFileSync(file, `${lines.join("\n")}\n`);
}
