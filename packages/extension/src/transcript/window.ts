import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { methodOf, once } from "../patch.ts";
import { transcriptState } from "./state.ts";

const DRAWN_ENTRIES = 500;
const TRIM_AT_ROWS = 2 * DRAWN_ENTRIES;

function earlierNotice(hidden: number): Component {
  const text = `${String(hidden)} earlier entries are not drawn in this pane. The session file and memory keep them.`;
  return {
    render: (width) => {
      const line = truncateToWidth(text, Math.max(width - 2, 0), "");
      const theme = transcriptState().theme;
      return [` ${theme === undefined ? line : theme.fg("muted", line)}`];
    },
    invalidate: () => undefined,
  };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function childrenOf(mode: object): unknown[] | undefined {
  const children = field(field(mode, "chatContainer"), "children");
  return Array.isArray(children) ? children : undefined;
}

function callsIn(entry: unknown): string[] {
  const message = field(entry, "message");
  const content = field(message, "content");
  if (field(message, "role") !== "assistant" || !Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    const id = field(block, "id");
    return field(block, "type") === "toolCall" && typeof id === "string" ? [id] : [];
  });
}

function answeredCall(entry: unknown): string | undefined {
  const message = field(entry, "message");
  const id = field(message, "toolCallId");
  return field(message, "role") === "toolResult" && typeof id === "string" ? id : undefined;
}

function withoutOrphanResults(entries: readonly unknown[]): unknown[] {
  const called = new Set<string>();
  return entries.filter((entry) => {
    for (const id of callsIn(entry)) called.add(id);
    const answered = answeredCall(entry);
    return answered === undefined || called.has(answered);
  });
}

function rememberPrompts(
  mode: object,
  older: readonly unknown[],
  textOf: (mode: object, message: unknown) => unknown,
): void {
  const editor = field(mode, "editor");
  const add = field(editor, "addToHistory");
  if (typeof add !== "function") return;
  for (const entry of older) {
    const message = field(entry, "message");
    if (field(entry, "type") !== "message" || field(message, "role") !== "user") continue;
    const text = textOf(mode, message);
    if (typeof text === "string") Reflect.apply(add, editor, [text]);
  }
}

function isScrolledUp(mode: object): boolean {
  return field(field(mode, "renderer"), "isFollowingOutput") === false;
}

export function limitDrawnHistory(): void {
  once("history-window", () => {
    const render = methodOf(InteractiveMode.prototype, "renderSessionEntries");
    const textOf = methodOf(InteractiveMode.prototype, "getUserMessageText");
    methodOf(InteractiveMode.prototype, "rebuildChatFromMessages");
    Reflect.set(
      InteractiveMode.prototype,
      "renderSessionEntries",
      function (this: object, entries: unknown, ...rest: unknown[]): unknown {
        transcriptState().mode = this;
        if (!Array.isArray(entries) || entries.length <= DRAWN_ENTRIES)
          return render(this, entries, ...rest);
        const drawn = withoutOrphanResults(entries.slice(-DRAWN_ENTRIES));
        if (field(rest[0], "populateHistory") === true)
          rememberPrompts(this, entries.slice(0, -DRAWN_ENTRIES), textOf);
        const children = childrenOf(this);
        const start = children?.length ?? 0;
        const result = render(this, drawn, ...rest);
        children?.splice(start, 0, earlierNotice(entries.length - drawn.length));
        return result;
      },
    );
  });
}

export function trimDrawnHistory(): void {
  const mode = transcriptState().mode;
  if (mode === undefined || isScrolledUp(mode)) return;
  if ((childrenOf(mode)?.length ?? 0) <= TRIM_AT_ROWS) return;
  methodOf(InteractiveMode.prototype, "rebuildChatFromMessages")(mode);
}
