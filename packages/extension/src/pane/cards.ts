import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boardUrl } from "../board-link.ts";
import type { List } from "./list.ts";
import { PulseView } from "./view.ts";

const OVERLAY = { width: "80%", minWidth: 56, maxHeight: "90%" } as const;
const SHARE_OF_SCREEN = 0.9;

export async function showCards(
  ctx: ExtensionContext,
  list: List,
  carddUrl: string,
): Promise<void> {
  const base = boardUrl(carddUrl);
  const links = { urlOf: (card: number): string => `${base}#/c-${String(card)}` };
  const picked = await ctx.ui.custom<number | undefined>(
    (tui, theme, _keys, done) =>
      new PulseView(
        theme,
        list,
        links,
        () => Math.floor(tui.terminal.rows * SHARE_OF_SCREEN),
        done,
      ),
    { overlay: true, overlayOptions: OVERLAY },
  );
  if (picked !== undefined) ctx.ui.notify(`c-${String(picked)}: ${links.urlOf(picked)}`, "info");
}
