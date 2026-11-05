import { parseCdp, type Cdp, type OpResult } from "@fleet/protocol";
import Type from "typebox";
import type { DatabaseSync } from "node:sqlite";
import { scrubbedOrHidden } from "./browser-hidden.ts";
import type { Tab } from "./browser-store.ts";
import type { Vault } from "./browser-vault.ts";
import { getCard } from "./store.ts";

const TargetsSchema = Type.Object({
  targetInfos: Type.Array(
    Type.Object({ targetId: Type.String(), title: Type.String(), url: Type.String() }),
  ),
});

export interface Listed {
  readonly title: string;
  readonly url: string;
}

export async function targetsOf(cdp: Cdp): Promise<Map<string, Listed>> {
  const listed = parseCdp(TargetsSchema, await cdp.send("Target.getTargets"), "the target list");
  return new Map(listed.targetInfos.map(({ targetId, title, url }) => [targetId, { title, url }]));
}

export function hiderOf(vault: Vault, captain: boolean): (text: string) => string {
  if (captain) return (text) => text;
  if (!vault.settled) return () => "";
  const secrets = vault.values;
  return (text) => scrubbedOrHidden(text, secrets);
}

export function tabView(
  db: DatabaseSync,
  tab: Tab,
  targets: ReadonlyMap<string, Listed>,
  hide: (text: string) => string,
): OpResult<"browser.view">["tabs"][number] {
  const here = targets.get(tab.target);
  return {
    card: tab.card,
    name: getCard(db, tab.card).name,
    label: tab.label,
    target: tab.target,
    host: tab.host,
    live: here !== undefined,
    title: hide((here?.title ?? "").replace(`${tab.label} - `, "").replace(tab.label, "")),
    url: hide(here?.url ?? ""),
  };
}
