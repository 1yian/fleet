import type { Link } from "./link.ts";

export async function releaseBrowser(link: Link, card: number): Promise<string> {
  const { closed, note } = await link.call("browser.release", { card });
  const said =
    closed === 0 ? "" : ` Closed ${String(closed)} browser tab${closed === 1 ? "" : "s"}.`;
  return note === null ? said : `${said} Browser: ${note}`;
}
