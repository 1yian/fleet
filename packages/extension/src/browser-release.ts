import type { Link } from "./link.ts";

export async function releaseBrowser(link: Link, card: number): Promise<string> {
  try {
    const { closed, note } = await link.call("browser.release", { card });
    const said =
      closed === 0 ? "" : ` Closed ${String(closed)} browser tab${closed === 1 ? "" : "s"}.`;
    return note === null ? said : `${said} Browser: ${note}`;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return ` Browser tabs of c-${String(card)} could not be checked: ${why}`;
  }
}
