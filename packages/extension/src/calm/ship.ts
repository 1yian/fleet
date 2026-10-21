import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  CALM_WORKING_SHIP_TICK_MS,
  createCalmWorkingShipSprite,
  type CalmWorkingShipColor,
  type CalmWorkingShipRun,
} from "./ship-sprite.ts";

const ANSI_FOREGROUND: Record<Exclude<CalmWorkingShipColor, "plain">, string> = {
  water: "\u001b[34m",
  boat: "\u001b[33m",
};
const RESET = "\u001b[39m";

export const CALM_WORKING_SHIP_WIDGET_KEY = "calm-working-ship";

export interface CalmWorkingShipAnimation {
  tick: () => void;
  restoreLastRendered: () => void;
  reset: () => void;
  render: (width: number) => string[];
}

function paintRun(run: CalmWorkingShipRun): string {
  if (run.color === "plain") return run.text;
  return `${ANSI_FOREGROUND[run.color]}${run.text}${RESET}`;
}

export function createCalmWorkingShipAnimation(): CalmWorkingShipAnimation {
  const sprite = createCalmWorkingShipSprite();
  return {
    restoreLastRendered: sprite.restoreLastRendered,
    reset: sprite.reset,
    tick: sprite.tick,
    render: (width) => sprite.frame(width).map((row) => row.map(paintRun).join("")),
  };
}

export function createCalmWorkingShipWidget(
  tui: TUI,
  animation: CalmWorkingShipAnimation,
): Component & { dispose(): void } {
  let disposed = false;
  const timer = setInterval(() => {
    if (disposed) return;
    animation.tick();
    tui.requestRender();
  }, CALM_WORKING_SHIP_TICK_MS);
  timer.unref();

  return {
    render: (width) => (disposed ? [] : animation.render(width)),
    invalidate: () => undefined,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      animation.restoreLastRendered();
    },
  };
}
