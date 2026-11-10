import { parseCdp, type Cdp, type OpResult } from "@fleet/protocol";
import Type from "typebox";
import { isGone, reason, targetsOf } from "./browser-targets.ts";

const CreatedSchema = Type.Object({ targetId: Type.String() });
const WindowSchema = Type.Object({
  windowId: Type.Integer(),
  bounds: Type.Object({ windowState: Type.Optional(Type.String()) }),
});

export const plural = (count: number): string => `${String(count)} tab${count === 1 ? "" : "s"}`;

export async function openWindow(cdp: Cdp): Promise<string> {
  const { targetId } = parseCdp(
    CreatedSchema,
    await cdp.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
      background: true,
    }),
    "a new tab",
  );
  return targetId;
}

export async function raiseWindow(cdp: Cdp, target: string): Promise<void> {
  const { windowId, bounds } = parseCdp(
    WindowSchema,
    await cdp.send("Browser.getWindowForTarget", { targetId: target }),
    "the tab's window",
  );
  if (bounds.windowState === "minimized")
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await cdp.send("Target.activateTarget", { targetId: target });
}

export function unreachable(
  host: string,
  card: number,
  count: number,
  error: unknown,
): OpResult<"browser.release"> {
  return {
    closed: 0,
    note: `${reason(error)}. ${plural(count)} of c-${String(card)} stay open: cardd closes them when the browser on ${host} answers again.`,
  };
}

export async function closeTargets(
  cdp: Cdp,
  targets: readonly string[],
  forget: (target: string) => void,
): Promise<OpResult<"browser.release">> {
  const alive = new Set((await targetsOf(cdp)).keys());
  let closed = 0;
  const stuck: string[] = [];
  for (const target of targets.filter((each) => alive.has(each))) {
    try {
      await cdp.send("Target.closeTarget", { targetId: target });
      closed += 1;
    } catch (error) {
      if (!cdp.open) throw error;
      if (isGone(error)) closed += 1;
      else stuck.push(reason(error));
    }
    forget(target);
  }
  const note =
    stuck[0] === undefined ? null : `${plural(stuck.length)} could not be closed: ${stuck[0]}`;
  return { closed, note };
}
