import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { installPresentation } from "../patch.ts";
import { FLEET_ROW_TYPES, setConversationApart } from "./layout.ts";
import { transcriptState } from "./state.ts";

export default function transcript(pi: ExtensionAPI): void {
  installPresentation("Transcript", "message rule", setConversationApart);

  for (const type of FLEET_ROW_TYPES) {
    pi.registerMessageRenderer(type, (message, options, theme) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      const row = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line));
      row.addChild(new Text(theme.fg("customMessageText", text), 0, 0));
      return row;
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) transcriptState().theme = ctx.ui.theme;
  });
}
