import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { calmTextIsSubstantive } from "./preservation.ts";
import { calmActive } from "./state.ts";

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];

function once(name: string, install: () => void): void {
  const key = Symbol.for(`fleet:calm-patch:${name}`);
  if (Reflect.get(globalThis, key) === true) return;
  Reflect.set(globalThis, key, true);
  install();
}

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
      Reflect.set(this, "lastMessage", message);
    };
  });
}
