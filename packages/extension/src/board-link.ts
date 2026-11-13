import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { openForCaptain, routeLinkClicks } from "./open-url.ts";
import { onStatusClick } from "./status-click.ts";

const BOARD_STATUS_KEY = "fleet-board";
const BOARD_TEXT = "board";

export function boardUrl(carddUrl: string): string {
  return carddUrl.replace(/^ws/, "http").replace(/\/session$/, "/");
}

export function showBoardLink(ctx: ExtensionContext, carddUrl: string): void {
  const url = boardUrl(carddUrl);
  routeLinkClicks(() => {
    ctx.ui.notify(
      "Could not open the link in your browser. Connect Element's browser extension on your computer, then click again.",
      "error",
    );
  });
  const text = ctx.ui.theme.style(BOARD_TEXT, { fg: "mdLink", underline: true });
  ctx.ui.setStatus(BOARD_STATUS_KEY, getCapabilities().hyperlinks ? hyperlink(text, url) : text);
  onStatusClick(BOARD_STATUS_KEY, {
    text: BOARD_TEXT,
    act: () => {
      openForCaptain(url);
    },
  });
}
