import type { DatabaseSync } from "node:sqlite";
import { fillLogin } from "./browser-fill.ts";
import { documentOf, type Doc, type Page } from "./browser-page.ts";
import { credentialsOf, type Secret, type Vault } from "./browser-vault.ts";
import { addEntry, getCard } from "./store.ts";

function hostOf(text: string): string | undefined {
  const bare = text.trim().toLowerCase();
  if (bare === "" || /\s/.test(bare)) return undefined;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(bare) ? bare : `https://${bare}`).hostname;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

const covers = (entryHost: string, pageHost: string): boolean =>
  pageHost === entryHost || pageHost.endsWith(`.${entryHost}`);

function bestEntry(secrets: readonly Secret[], pageHost: string): Secret | undefined {
  const matching = secrets
    .map((secret) => ({ secret, host: hostOf(secret.key) }))
    .filter(({ host }) => host !== undefined && covers(host, pageHost));
  matching.sort((a, b) => (b.host?.length ?? 0) - (a.host?.length ?? 0));
  return matching[0]?.secret;
}

function requestFor(db: DatabaseSync, card: number, site: string): string[] {
  const asked = db
    .prepare(
      "SELECT 1 FROM entries WHERE card = ? AND author = 'browser' AND json_extract(fields, '$.loginFor') = ?",
    )
    .get(card, site);
  if (asked !== undefined) return [];
  const { lane } = getCard(db, card);
  const body = `c-${String(card)} needs a Bitwarden login for ${site}. Ask the captain to add one secret to the fleet's Logins project in Bitwarden Secrets Manager: key ${site}, value {"username": "...", "password": "..."}. Do not ask for the password in chat and do not paste it anywhere. When it is added, tell the worker to call login again.`;
  addEntry(
    db,
    { card, author: "browser", kind: "comment", body, fields: { for: "mate", loginFor: site } },
    [lane],
  );
  return [lane];
}

export interface LoginContext {
  readonly db: DatabaseSync;
  readonly vault: Vault;
  readonly card: number;
  readonly page: Page;
  readonly mark: (loader: string, fields: readonly string[]) => void;
}

async function siteOf(
  page: Page,
  requested: string | undefined,
): Promise<{ site: string; where: string; doc: Doc }> {
  const doc = await documentOf(page);
  const where = doc.host;
  if (where === "")
    throw new Error("open the site's login page in your tab first, then call login");
  const site = (requested === undefined ? undefined : hostOf(requested)) ?? where;
  if (!covers(site, where) && !covers(where, site))
    throw new Error(`your tab is on ${where}, not ${site}: open ${site}'s login page first`);
  return { site, where, doc };
}

function notFound(context: LoginContext, site: string, where: string): Done {
  const notify = requestFor(context.db, context.card, site);
  const said =
    notify.length > 0 ? "I asked your mate to have one added" : "your mate was already asked";
  const text = `not found: the Logins project has no entry for ${where}, and ${said}. Nothing was filled. Wait for the captain to add it (report paused or blocked until then), then call login again.`;
  return { text, notify };
}

interface Done {
  readonly text: string;
  readonly notify: string[];
}

export async function login(context: LoginContext, requested: string | undefined): Promise<Done> {
  const { vault, page } = context;
  const { logins } = vault;
  if (logins === undefined)
    throw new Error(
      "login is not set up on this fleet: cardd has no Bitwarden Logins project configured (docs/setup.md, The shared browser). Ask your mate",
    );
  const { site, where, doc } = await siteOf(page, requested);
  const entry = bestEntry(await vault.refresh(), where);
  if (entry === undefined) return notFound(context, site, where);
  const creds = credentialsOf(entry);
  const hold = (value: string): void => {
    vault.hold([value]);
  };
  const track = (fields: readonly string[]): void => {
    context.mark(doc.loader, fields);
  };
  return fillLogin(page, doc, creds, logins.totp === true, hold, track).then(
    (text) => ({ text: `filled: ${text} Entry: ${entry.key}.`, notify: [] }),
    (error: unknown) => {
      throw new Error(`login failed: ${error instanceof Error ? error.message : "it failed"}`);
    },
  );
}
