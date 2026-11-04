import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import type { LoginsConfig } from "./browser-config.ts";
import { fillLogin, type Credentials } from "./browser-fill.ts";
import { documentOf, type Doc, type Page } from "./browser-page.ts";
import type { Hosts } from "./pulls.ts";
import { addEntry, getCard } from "./store.ts";

const BWS_TIMEOUT_MS = 30_000;
const BWS_OUTPUT_BYTES = 16 * 1024 * 1024;

const SecretsSchema = Type.Array(
  Type.Object({ id: Type.String(), key: Type.String(), value: Type.String() }),
);
const CredentialsSchema = Type.Object({
  username: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 1 }),
  totp: Type.Optional(Type.String({ minLength: 1 })),
});

interface Secret {
  readonly key: string;
  readonly value: string;
}

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const shellPath = (path: string): string =>
  path.startsWith("~/") ? `"$HOME"${quote(path.slice(1))}` : quote(path);

const bwsScript = (logins: LoginsConfig): string =>
  `BWS_ACCESS_TOKEN="$(cat ${shellPath(logins.tokenFile)})" && export BWS_ACCESS_TOKEN && exec bws secret list ${quote(logins.project)} --output json`;

function listSecrets(logins: LoginsConfig, hosts: Hosts): Promise<Secret[]> {
  const via = hosts[logins.host] ?? [];
  const script = bwsScript(logins);
  const argv: string[] = via.length === 0 ? ["sh", "-c", script] : [...via, script];
  const [file = "sh", ...args] = argv;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: BWS_TIMEOUT_MS, maxBuffer: BWS_OUTPUT_BYTES },
      (error, out, err) => {
        if (error !== null) {
          const why = err
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "")
            .join(" ")
            .slice(0, 200);
          reject(
            new Error(
              `bws could not read the Logins project on ${logins.host}: ${why === "" ? "it failed" : why}`,
            ),
          );
          return;
        }
        try {
          resolve(parseCdp(SecretsSchema, JSON.parse(out), "bws's list"));
        } catch {
          reject(new Error(`bws on ${logins.host} did not answer with a list of secrets`));
        }
      },
    );
  });
}

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

function credentialsOf(entry: Secret): Credentials {
  try {
    return parseCdp(CredentialsSchema, JSON.parse(entry.value), "the entry");
  } catch {
    throw new Error(
      `the Bitwarden entry ${entry.key} is not usable: its value must be JSON like {"username": "...", "password": "..."}. Its content is not shown`,
    );
  }
}

const valuesOf = (creds: Credentials): string[] => [
  creds.username,
  creds.password,
  ...(creds.totp === undefined ? [] : [creds.totp]),
];

export async function valuesCovering(
  logins: LoginsConfig,
  hosts: Hosts,
  host: string,
): Promise<string[]> {
  const covering = (await listSecrets(logins, hosts)).filter((secret) => {
    const entryHost = hostOf(secret.key);
    return entryHost !== undefined && covers(entryHost, host);
  });
  return covering.flatMap((entry) => {
    try {
      return valuesOf(credentialsOf(entry));
    } catch {
      return [];
    }
  });
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
  readonly hosts: Hosts;
  readonly logins: LoginsConfig | undefined;
  readonly card: number;
  readonly page: Page;
  readonly hide: (values: readonly string[]) => void;
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
  const { hosts, logins, page } = context;
  if (logins === undefined)
    throw new Error(
      "login is not set up on this fleet: cardd has no Bitwarden Logins project configured (docs/setup.md, The shared browser). Ask your mate",
    );
  const { site, where, doc } = await siteOf(page, requested);
  const entry = bestEntry(await listSecrets(logins, hosts), where);
  if (entry === undefined) return notFound(context, site, where);
  const creds = credentialsOf(entry);
  context.hide(valuesOf(creds));
  return fillLogin(page, doc, creds, logins.totp === true).then(
    (text) => ({ text: `filled: ${text} Entry: ${entry.key}.`, notify: [] }),
    (error: unknown) => {
      throw new Error(`login failed: ${error instanceof Error ? error.message : "it failed"}`);
    },
  );
}
