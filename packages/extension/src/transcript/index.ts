import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { readLaneConfig } from "../lane-config.ts";
import { installPresentation } from "../patch.ts";
import { mateTitle } from "../titles.ts";
import { setConversationApart } from "./layout.ts";
import { transcriptState } from "./state.ts";

const FLEET_ROWS = ["fleet", "fleet-link", "fleet-update"];

export default function transcript(pi: ExtensionAPI): void {
  installPresentation("Transcript", "message rule", setConversationApart);

  for (const type of FLEET_ROWS) {
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

  const lane = readLaneConfig(process.cwd())?.lane;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const state = transcriptState();
    state.theme = () => ctx.ui.theme;
    if (lane !== undefined) state.mate = mateTitle(lane);
  });
}
