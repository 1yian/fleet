import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

const BOARD_STATUS_KEY = "fleet-board";

function boardUrl(carddUrl: string): string {
  return carddUrl.replace(/^ws/, "http").replace(/\/session$/, "/");
}

export function showBoardLink(ctx: ExtensionContext, carddUrl: string): void {
  const url = boardUrl(carddUrl);
  ctx.ui.setStatus(BOARD_STATUS_KEY, getCapabilities().hyperlinks ? hyperlink(url, url) : url);
}
