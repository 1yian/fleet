import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TiersCatalogSchema } from "@fleet/protocol";
import Value from "typebox/value";
import { readTiersConfig } from "./tiers-config.ts";
import { errorText } from "./views.ts";

type Registry = Pick<ExtensionContext["modelRegistry"], "findOfType" | "getProviderAuthStatus">;

interface Catalog {
  readonly tiers: ReadonlyMap<string, string>;
  readonly classifier: string | undefined;
}

const TIER_MODEL = /^tier\/([^:\s]+)(?::\S*)?$/;

function readCatalog(): Catalog | undefined {
  const raw = readTiersConfig();
  if (!Value.Check(TiersCatalogSchema, raw)) return undefined;
  const tiers = new Map(
    Object.entries(raw.tiers).map(([name, tier]) => [name, tier.description?.trim() ?? ""]),
  );
  return tiers.size === 0 ? undefined : { tiers, classifier: raw.auto?.classifier };
}

function routerWorks(registry: Registry, classifier: string | undefined): boolean {
  if (classifier === undefined) return false;
  const at = classifier.indexOf("/");
  const provider = classifier.slice(0, at);
  return (
    registry.findOfType("classifier", provider, classifier.slice(at + 1)) !== undefined &&
    registry.getProviderAuthStatus(provider).configured
  );
}

export function workerTiersSection(registry: Registry): string {
  const catalog = readCatalog();
  if (catalog === undefined || routerWorks(registry, catalog.classifier)) return "";
  const lines = [...catalog.tiers].map(([name, description]) =>
    description === "" ? `- tier/${name}` : `- tier/${name}: ${description}`,
  );
  return `\n\n${[
    "## Worker tiers",
    "No tier router works on this install, so nothing picks a worker's tier for the work: a dispatch with no `model` runs on the lane's or Pi's default model. These are the tiers this install's tiers.json defines:",
    ...lines,
  ].join("\n")}`;
}

export function requireDefinedTier(model: string | undefined): void {
  if (model === undefined) return;
  const name = TIER_MODEL.exec(model)?.[1];
  const catalog = readCatalog();
  if (name === undefined || catalog === undefined) return;
  if (catalog.tiers.has(name) || (name === "auto" && catalog.classifier !== undefined)) return;
  const defined = [...catalog.tiers.keys()].map((each) => `tier/${each}`);
  throw new Error(
    errorText(`${model} is not a tier this install defines`, [
      `Call dispatch again with model set to one of: ${defined.join(", ")}`,
    ]),
  );
}
