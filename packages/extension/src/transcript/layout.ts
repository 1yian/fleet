import {
  AssistantMessageComponent,
  CustomMessageComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { patchRender } from "../patch.ts";
import { messageRule, setApart } from "./rule.ts";
import { transcriptState } from "./state.ts";

const CAPTAIN = "captain";
const FLEET = "fleet";

function fleetRow(row: object): boolean {
  const message: unknown = Reflect.get(row, "message");
  const type: unknown =
    typeof message === "object" && message !== null
      ? Reflect.get(message, "customType")
      : undefined;
  return typeof type === "string" && (type === FLEET || type.startsWith(`${FLEET}-`));
}

function setMessagesApart(
  proto: object,
  name: string,
  senderOf: (row: object) => string | undefined,
): void {
  patchRender(proto, name, (row, width, drawn) => {
    const body = drawn();
    const sender = senderOf(row);
    const theme = transcriptState().theme?.();
    if (sender === undefined || theme === undefined) return body;
    return setApart(body, theme.fg("borderMuted", messageRule(sender, width)));
  });
}

export function setConversationApart(): void {
  setMessagesApart(UserMessageComponent.prototype, "transcript-user", () => CAPTAIN);
  setMessagesApart(
    AssistantMessageComponent.prototype,
    "transcript-assistant",
    () => transcriptState().mate,
  );
  setMessagesApart(CustomMessageComponent.prototype, "transcript-fleet", (row) =>
    fleetRow(row) ? FLEET : undefined,
  );
}
