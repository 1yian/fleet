// How Calm hides rows. Pi has no global transcript filter, so Calm patches the render
// of the three components that draw operational chrome. Each patch only decides what a
// row draws while Calm is on. It never touches a message, the model's context, the
// session file, or an export, and turning Calm off draws every row as stock Pi does.
//
//   - ToolExecutionComponent: every tool row, built-in or custom, draws nothing. A row
//     with an image stays, because an image is content.
//   - CustomMessageComponent: a `[fleet] ...` message (customType "fleet") draws nothing.
//     It is fleet's own operational row, the way Firstmate's operational user rows are.
//   - AssistantMessageComponent: collapsed thinking and short pre-tool text blocks are
//     removed from a shallow copy before layout.
//
// Each patch probes the exact Pi member it replaces and throws when it is missing, and
// ./index.ts skips only that patch with a diagnostic, so a future Pi that moves one seam
// leaves Calm's other parts working. A patch installs once per process: a reload
// evaluates this module again, but the shared state in ./state.ts is what the one
// installed patch reads.
import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { calmTextIsSubstantive } from "./preservation.ts";
import { calmActive } from "./state.ts";

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];

/** Runs `install` the first time it is called for `name` in this process. */
function once(name: string, install: () => void): void {
  const key = Symbol.for(`fleet:calm-patch:${name}`);
  if (Reflect.get(globalThis, key) === true) return;
  Reflect.set(globalThis, key, true);
  install();
}

/** The component's own method, or an error naming what this Pi lacks. */
function methodOf(proto: object, member: string): (self: object, ...args: unknown[]) => unknown {
  const method: unknown = Reflect.get(proto, member);
  if (typeof method !== "function") throw new Error(`Fleet Calm requires Pi ${member}()`);
  return (self, ...args) => {
    const result: unknown = Reflect.apply(method, self, args);
    return result;
  };
}

function lines(value: unknown): string[] {
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value;
  throw new Error("Pi's render did not return lines");
}

/** Replaces `render` so it draws nothing while `hides` says so. */
function hideRender(proto: object, name: string, hides: (row: object) => boolean): void {
  once(name, () => {
    const original = methodOf(proto, "render");
    Reflect.set(proto, "render", function (this: object, width: number): string[] {
      return hides(this) ? [] : lines(original(this, width));
    });
  });
}

const hasImages = (row: object): boolean => {
  const images: unknown = Reflect.get(row, "imageComponents");
  // Without Pi's image list, assume images: showing a row is the safe error.
  return !Array.isArray(images) || images.length > 0;
};

export function hideToolRows(): void {
  hideRender(ToolExecutionComponent.prototype, "ToolExecutionComponent", (row) => {
    return calmActive() && !hasImages(row);
  });
}

export function hideFleetMessages(): void {
  hideRender(CustomMessageComponent.prototype, "CustomMessageComponent", (row) => {
    const message: unknown = Reflect.get(row, "message");
    return (
      calmActive() &&
      typeof message === "object" &&
      message !== null &&
      "customType" in message &&
      message.customType === "fleet"
    );
  });
}

/** A message the model did not end its run with: Pi runs its tool calls, then asks again. */
function midTurn(message: AssistantMessage): boolean {
  if (message.stopReason === "toolUse") return true;
  return (
    message.stopReason === "length" && message.content.some((block) => block.type === "toolCall")
  );
}

export function hideAssistantChrome(): void {
  once("assistant-chrome", () => {
    const original = methodOf(AssistantMessageComponent.prototype, "updateContent");
    AssistantMessageComponent.prototype.updateContent = function (
      this: AssistantMessageComponent,
      message: AssistantMessage,
      isStreaming?: boolean,
    ) {
      const active = calmActive();
      // The collapsed-thinking label is "" only while Calm is on and thinking is collapsed.
      const dropThinking =
        active &&
        Reflect.get(this, "hiddenThinkingLabel") === "" &&
        Reflect.get(this, "hideThinkingBlock") === true;
      const dropNotes = active && midTurn(message);
      const shown = message.content.filter(
        (block) =>
          !(dropThinking && block.type === "thinking") &&
          !(dropNotes && block.type === "text" && !calmTextIsSubstantive(block.text)),
      );
      const presented =
        shown.length === message.content.length ? message : { ...message, content: shown };
      original(this, presented, isStreaming);
      // Pi's later refreshes read the full message back, so keep that one.
      Reflect.set(this, "lastMessage", message);
    };
  });
}
