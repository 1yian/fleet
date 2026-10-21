import {
  AssistantMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { methodOf, once, patchRender } from "../patch.ts";
import { calmTextIsSubstantive } from "./preservation.ts";
import { calmActive } from "./state.ts";

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];

function hideRender(proto: object, name: string, hides: (row: object) => boolean): void {
  patchRender(proto, name, (row, _width, drawn) => (hides(row) ? [] : drawn()));
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
