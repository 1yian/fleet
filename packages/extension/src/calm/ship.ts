// The fleet mate's Calm-only animated working presentation for Pi, ported from Firstmate.
//
// Calm replaces Pi's stock working row with a tiny boat while one logical agent run is
// active. The sprite geometry, bounce track, two animation cadences, palette classes,
// and freeze/resume state are owned by ./ship-sprite.ts; this module owns only Pi's
// rendering of those frames as standard ANSI escapes and the temporary TUI widget.
// ./index.ts owns when the presentation is installed and removed, and stays the sole
// caller of setWorkingVisible().
//
// Continuity: one extension-owned animation instance survives hide/show within the same
// Pi process and Calm extension lifetime. Disposing the widget freezes column,
// direction, water phase, and tick cadence without advancing them for hidden wall
// time. The next working period resumes from that exact logical state. A fresh session
// or new extension lifetime calls reset() and starts at the normal initial position.
//
// Pi renders a widget through Component.render(width), so this module recomputes its
// track from that width on every frame instead of caching a terminal size that a resize
// would invalidate.
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  CALM_WORKING_SHIP_TICK_MS,
  createCalmWorkingShipSprite,
  type CalmWorkingShipColor,
  type CalmWorkingShipRun,
} from "./ship-sprite.ts";

// Standard ANSI foreground codes only: no theme lookup, bright variant, or 256/RGB.
// Water is a single blue so the swell reads through glyph height alone; the boat is a
// single yellow so its sail halves, mast, and hull never split into mismatched colors.
const ANSI_FOREGROUND: Record<Exclude<CalmWorkingShipColor, "plain">, string> = {
  water: "\u001b[34m",
  boat: "\u001b[33m",
};
// Restores the default foreground so color never bleeds into padding or later frames.
const RESET = "\u001b[39m";

// The working-row widget slot is shared with Firstmate's Calm and the standalone Pi Calm,
// which install their boat under the same "calm-working-ship" key. Pi replaces widgets
// under one key, so a session that loads more than one renders a single boat.
export const CALM_WORKING_SHIP_WIDGET_KEY = "calm-working-ship";

export interface CalmWorkingShipAnimation {
  /** Advance one scheduler tick. */
  tick: () => void;
  /** Freeze at the last painted frame, without applying hidden wall time. */
  restoreLastRendered: () => void;
  /** Return to the normal initial position. */
  reset: () => void;
  /** Render one frame that exactly fits `width`, clamping the track to it first. */
  render: (width: number) => string[];
}

/** One run painted as its standard ANSI escape, closed with a default-foreground reset. */
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

/**
 * Build the temporary Calm working widget bound to one caller-owned animation.
 * Pi disposes the previous component before installing a replacement under the same
 * key and when it clears extension widgets, so the single scheduler driving both
 * cadences cannot outlive the widget or duplicate. Disposing freezes the shared
 * animation in place; the next widget bound to the same animation resumes without
 * applying hidden wall time.
 */
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
  // The animation must never keep Pi's process alive on its own.
  timer.unref();

  return {
    render: (width) => (disposed ? [] : animation.render(width)),
    // Every frame is rebuilt from fixed standard ANSI codes, so there is no cache.
    invalidate: () => undefined,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      animation.restoreLastRendered();
    },
  };
}
