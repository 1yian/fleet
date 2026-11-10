import type { Cdp } from "@fleet/protocol";
import { stepsOf, type Page } from "./browser-page.ts";
import type { Tab } from "./browser-store.ts";
import { targetsOf, type Listed, type Standing } from "./browser-targets.ts";
import { within } from "./browser-wait.ts";

const LISTING_MS = 3_000;

export interface Listing {
  readonly targets: Map<string, Listed>;
  readonly standing: Map<string, Standing>;
}

async function standingOf(
  attach: (tab: Tab) => Promise<Page>,
  tabs: readonly Tab[],
  targets: ReadonlyMap<string, Listed>,
): Promise<Map<string, Standing>> {
  const found = await Promise.all(
    tabs
      .filter((tab) => targets.has(tab.target))
      .map(async (tab): Promise<[string, Standing] | undefined> => {
        try {
          const steps = await stepsOf(await attach(tab));
          return [
            tab.target,
            {
              canBack: steps.back !== undefined,
              canForward: steps.forward !== undefined,
            },
          ];
        } catch {
          return undefined;
        }
      }),
  );
  return new Map(found.filter((each) => each !== undefined));
}

export function listTabs(
  host: string,
  connection: Promise<Cdp>,
  attach: (cdp: Cdp, tab: Tab) => Promise<Page>,
  tabs: readonly Tab[],
): Promise<Listing> {
  const late = `the browser on ${host} is unavailable: it did not answer within ${String(LISTING_MS / 1000)} s (it may still be connecting)`;
  const listed = connection.then(async (cdp) => {
    const targets = await targetsOf(cdp);
    return {
      targets,
      standing: await standingOf((tab) => attach(cdp, tab), tabs, targets),
    };
  });
  return within(LISTING_MS, listed, late);
}
