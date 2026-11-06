import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { methodOf, once } from "../patch.ts";
import { transcriptState } from "./state.ts";

const DRAWN_ENTRIES = 500;

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

function childrenOf(mode: object): unknown[] | undefined {
  const chat: unknown = Reflect.get(mode, "chatContainer");
  const children: unknown =
    typeof chat === "object" && chat !== null && Reflect.get(chat, "children");
  return Array.isArray(children) ? children : undefined;
}

export function limitDrawnHistory(): void {
  once("history-window", () => {
    const original = methodOf(InteractiveMode.prototype, "renderSessionEntries");
    Reflect.set(
      InteractiveMode.prototype,
      "renderSessionEntries",
      function (this: object, entries: unknown, ...rest: unknown[]): unknown {
        if (!Array.isArray(entries) || entries.length <= DRAWN_ENTRIES)
          return original(this, entries, ...rest);
        const children = childrenOf(this);
        const start = children?.length ?? 0;
        const drawn = original(this, entries.slice(-DRAWN_ENTRIES), ...rest);
        children?.splice(start, 0, earlierNotice(entries.length - DRAWN_ENTRIES));
        return drawn;
      },
    );
  });
}
