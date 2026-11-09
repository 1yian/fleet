import { addressTyped, checkedUrl, type BrowserArgs } from "@fleet/protocol";
import Type, { type Static } from "typebox";

export const NavSchema = Type.Union([
  Type.Object({ target: Type.String(), action: Type.Enum(["back", "forward", "reload"]) }),
  Type.Object({ target: Type.String(), action: Type.Literal("open"), url: Type.String() }),
]);
export type Nav = Static<typeof NavSchema>;

export function navArgs(nav: Nav): BrowserArgs {
  return nav.action === "open"
    ? { action: "open", url: checkedUrl(addressTyped(nav.url)) }
    : { action: nav.action };
}
