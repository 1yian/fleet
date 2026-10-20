// Calm mode for fleet mates: a /calm toggle that hides operational transcript chrome
// (tool rows, `[fleet] ...` messages, collapsed thinking, short pre-tool assistant text)
// and shows a small working boat while the mate works. Pi's session keeps every row in
// the model's context, the session file, and exports; only the live transcript changes.
//
// This is its own Pi extension, loaded by the repo's .pi/extensions/fleet.ts only in a lane home
// (a folder with config/lane.json), so workers never get it. The choice is saved per mate home in config/calm and is
// read again at every session start. Calm is off until the first /calm.
// Ported from Firstmate's Calm; docs/calm.md owns the user-facing behavior.
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { hideAssistantChrome, hideFleetMessages, hideToolRows } from "./layout.ts";
import { loadPreference, preferenceFile, savePreference } from "./preference.ts";
import { calmActive, setCalmActive } from "./state.ts";
import {
  CALM_WORKING_SHIP_WIDGET_KEY,
  createCalmWorkingShipAnimation,
  createCalmWorkingShipWidget,
} from "./ship.ts";

// Other extensions follow Calm on this event. Firstmate's Calm publishes the same one,
// so a readable-transcript extension written for it stays out of Calm's way here too.
const PRESENTATION_EVENT = "firstmate:calm-presentation";

/** Each patch probes the Pi member it replaces. A Pi without it loses only that part of Calm. */
function install(name: string, patch: () => void): void {
  try {
    patch();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Fleet Calm: the ${name} presentation is unavailable, skipping. ${reason}`);
  }
}

export default function calm(pi: ExtensionAPI): void {
  install("tool row", hideToolRows);
  install("fleet message", hideFleetMessages);
  install("assistant text", hideAssistantChrome);

  // One logical agent run, from agent_start to agent_settled, so the boat does not
  // flicker between tool calls, continuations, or retries inside the same run.
  let running = false;
  let boatShown = false;
  // One animation per extension lifetime: hiding the widget freezes it, and the next
  // working period resumes from there.
  const animation = createCalmWorkingShipAnimation();

  const showBoat = (ui: ExtensionUIContext, force = false): void => {
    const show = running && calmActive();
    if (show === boatShown && !(force && !show)) return;
    boatShown = show;
    if (show) {
      ui.setWidget(CALM_WORKING_SHIP_WIDGET_KEY, (tui) =>
        createCalmWorkingShipWidget(tui, animation),
      );
      ui.setWorkingVisible(false);
    } else {
      ui.setWidget(CALM_WORKING_SHIP_WIDGET_KEY, undefined);
      ui.setWorkingVisible(true);
    }
  };

  const apply = (ui: ExtensionUIContext, active: boolean): void => {
    setCalmActive(active);
    pi.events.emit(PRESENTATION_EVENT, { active, stockExportRendering: false });
    showBoat(ui, true);
    // Pi re-runs every assistant row's layout from this call even when the label is
    // unchanged, which is what makes a toggle apply to rows already on screen.
    ui.setHiddenThinkingLabel(active ? "" : undefined);
  };

  pi.on("session_start", (_event, ctx) => {
    running = false;
    boatShown = false;
    animation.reset();
    const active = loadPreference(preferenceFile());
    // Without a terminal (print and RPC modes) there is nothing to hide or draw.
    if (ctx.hasUI) apply(ctx.ui, active);
    else setCalmActive(active);
  });
  pi.on("agent_start", (_event, ctx) => {
    running = true;
    if (ctx.hasUI) showBoat(ctx.ui);
  });
  // agent_settled also covers abort and failure.
  pi.on("agent_settled", (_event, ctx) => {
    running = false;
    if (ctx.hasUI) showBoat(ctx.ui);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    running = false;
    if (ctx.hasUI) showBoat(ctx.ui);
  });

  pi.registerCommand("calm", {
    description: "Toggle calm mode: hide tool rows and fleet messages, and show a working boat.",
    handler: (_args, ctx) => {
      const active = !calmActive();
      try {
        // Save first: a failed write leaves the choice and the screen unchanged.
        savePreference(preferenceFile(), active);
      } catch (error) {
        ctx.ui.notify(
          `Calm not changed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return Promise.resolve();
      }
      apply(ctx.ui, active);
      return Promise.resolve();
    },
  });
}
