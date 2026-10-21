import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { installPresentation } from "../patch.ts";
import { hideAssistantChrome, hideFleetMessages, hideToolRows } from "./layout.ts";
import { loadPreference, preferenceFile, savePreference } from "./preference.ts";
import { calmActive, setCalmActive } from "./state.ts";
import {
  CALM_WORKING_SHIP_WIDGET_KEY,
  createCalmWorkingShipAnimation,
  createCalmWorkingShipWidget,
} from "./ship.ts";

const PRESENTATION_EVENT = "firstmate:calm-presentation";

function install(name: string, patch: () => void): void {
  installPresentation("Calm", name, patch);
}

function redrawAssistantRows(ui: ExtensionUIContext): void {
  ui.setHiddenThinkingLabel(undefined);
}

export default function calm(pi: ExtensionAPI): void {
  install("tool row", hideToolRows);
  install("fleet message", hideFleetMessages);
  install("assistant text", hideAssistantChrome);

  let running = false;
  let boatShown = false;
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
    redrawAssistantRows(ui);
  };

  pi.on("session_start", (_event, ctx) => {
    running = false;
    boatShown = false;
    animation.reset();
    const active = loadPreference(preferenceFile());
    if (ctx.hasUI) apply(ctx.ui, active);
    else setCalmActive(active);
  });
  pi.on("agent_start", (_event, ctx) => {
    running = true;
    if (ctx.hasUI) showBoat(ctx.ui);
  });
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
