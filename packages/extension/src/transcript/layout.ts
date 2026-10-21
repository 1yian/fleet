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

export const FLEET_ROW_TYPES: readonly string[] = [
  "fleet",
  "fleet-link",
  "fleet-update",
  "fleet-clones",
  "fleet-lanes",
];

function fleetRow(row: object): boolean {
  const message: unknown = Reflect.get(row, "message");
  const type: unknown =
    typeof message === "object" && message !== null
      ? Reflect.get(message, "customType")
      : undefined;
  return typeof type === "string" && FLEET_ROW_TYPES.includes(type);
}

const UNLABELED = null;

type Sender = string | typeof UNLABELED | undefined;

function setMessagesApart(proto: object, name: string, senderOf: (row: object) => Sender): void {
  patchRender(proto, name, (row, width, drawn) => {
    const body = drawn();
    const sender = senderOf(row);
    const theme = transcriptState().theme;
    if (sender === undefined || theme === undefined) return body;
    return setApart(
      body,
      theme.fg("borderMuted", messageRule(sender === UNLABELED ? undefined : sender, width)),
    );
  });
}

export function setConversationApart(): void {
  setMessagesApart(UserMessageComponent.prototype, "transcript-user", () => CAPTAIN);
  setMessagesApart(AssistantMessageComponent.prototype, "transcript-assistant", () => UNLABELED);
  setMessagesApart(CustomMessageComponent.prototype, "transcript-fleet", (row) =>
    fleetRow(row) ? FLEET : undefined,
  );
}
