import { spawn } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { onStatusClick } from "./status-click.ts";

const BOARD_STATUS_KEY = "fleet-board";
const BOARD_TEXT = "board";

export function boardUrl(carddUrl: string): string {
  return carddUrl.replace(/^ws/, "http").replace(/\/session$/, "/");
}

function openUrl(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true, cwd: "/" })
    .on("error", () => undefined)
    .unref();
}

export function showBoardLink(ctx: ExtensionContext, carddUrl: string): void {
  const url = boardUrl(carddUrl);
  const text = ctx.ui.theme.style(BOARD_TEXT, { fg: "mdLink", underline: true });
  if (getCapabilities().hyperlinks) {
    ctx.ui.setStatus(BOARD_STATUS_KEY, hyperlink(text, url));
    return;
  }
  ctx.ui.setStatus(BOARD_STATUS_KEY, text);
  onStatusClick(BOARD_STATUS_KEY, {
    text: BOARD_TEXT,
    act: () => {
      openUrl(url);
    },
  });
}
