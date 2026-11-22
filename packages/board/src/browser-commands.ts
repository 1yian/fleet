import type { BrowserCommand, BrowserState } from "@fleet/protocol";

export type BrowserInput =
  | {
      t: "mouse";
      type: "mouseMoved" | "mousePressed" | "mouseReleased";
      x: number;
      y: number;
      button: string;
      buttons: number;
      clickCount: number;
      modifiers: number;
    }
  | { t: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
      t: "key";
      type: "keyDown" | "rawKeyDown" | "keyUp";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      modifiers: number;
    };

export type Pending = "take" | "done" | { readonly tab: string };
export function commandFor(pending: Pending): BrowserCommand {
  if (pending === "take") return { t: "control", on: true };
  if (pending === "done") return { t: "done" };
  return { t: "tab", action: "activate", id: pending.tab };
}

export function commandError(pending: Pending): string {
  if (pending === "take") return "Couldn’t take control. You’re still watching.";
  if (pending === "done") return "Couldn’t return control. Try Done again.";
  return "Couldn’t switch tabs. Try again.";
}

export interface Status {
  readonly state?: BrowserState | undefined;
  readonly pending?: Pending | undefined;
  readonly notice?: string | undefined;
  readonly offline?: boolean | undefined;
  readonly fenced?: boolean | undefined;
  readonly halted?: boolean | undefined;
}

export const LOST = "Control ended. You’re watching again.";
export const CHANGED = "The remote browser changed before your request went through. Try again.";
export const AMBIGUOUS =
  "The last change may not have finished, so input and control changes are off. You can keep watching. Leave this page to hand control back to the agent.";
