import { type BrokerConfig, laneVaultName } from "./config.js";
import { BrokerError } from "./errors.js";
import type { OpCli } from "./opcli.js";

const SYNCED_TAG = "fleet-browser-synced";
const LANE_OWNED_TAG = "fleet-browser-lane-owned";

interface VaultInfo {
  id: string;
  name: string;
}

interface ListedItem {
  id: string;
  title: string;
  tags?: string[];
}

interface SourceField {
  id?: string;
  type?: string;
  purpose?: string;
  label?: string;
  value?: string;
  section?: { id?: string; label?: string };
}

interface SourceItem {
  title: string;
  category: string;
  sections?: Array<{ id?: string; label?: string }>;
  fields?: SourceField[];
  urls?: Array<{ label?: string; primary?: boolean; href?: string }>;
}

export interface LaneSync {
  copied: number;
  failed: number;
  removed: number;
}

export type Log = (line: string) => void;

async function ensureLaneVault(cli: OpCli, lane: string): Promise<string> {
  const name = laneVaultName(lane);
  try {
    const vault = JSON.parse(
      await cli.run(["vault", "get", name, "--format", "json"], { reads: 2 }),
    ) as VaultInfo;
    if (vault.name !== name)
      throw new BrokerError("OP_ERROR", "1Password returned a different vault than asked");
    return vault.id;
  } catch (error) {
    if (!(error instanceof BrokerError) || error.code !== "ITEM_NOT_FOUND") throw error;
  }
  return (JSON.parse(await cli.run(["vault", "create", name, "--format", "json"])) as VaultInfo).id;
}

async function listItems(cli: OpCli, vaultId: string): Promise<ListedItem[]> {
  const out = await cli.run(["item", "list", "--vault", vaultId, "--format", "json"]);
  return out.trim() === "" ? [] : (JSON.parse(out) as ListedItem[]);
}

function copyTemplate(source: SourceItem): Record<string, unknown> {
  return {
    title: source.title,
    category: source.category,
    tags: [SYNCED_TAG],
    sections: (source.sections ?? []).map((s) => ({ id: s.id, label: s.label })),
    fields: (source.fields ?? [])
      .filter((f) => f.value !== undefined && f.value !== "")
      .map((f) => ({
        id: f.id,
        type: f.type,
        purpose: f.purpose,
        label: f.label,
        value: f.value,
        section: f.section,
      })),
    urls: (source.urls ?? []).map((u) => ({ label: u.label, primary: u.primary, href: u.href })),
  };
}

async function createItem(cli: OpCli, vaultId: string, template: Record<string, unknown>): Promise<string> {
  const out = await cli.run(["item", "create", "--vault", vaultId, "--format", "json"], {
    stdin: JSON.stringify(template),
  });
  return (JSON.parse(out) as { id: string }).id;
}

function codeOf(error: unknown): string {
  return error instanceof BrokerError ? error.code : "OP_ERROR";
}

async function deleteItem(
  cli: OpCli,
  vaultId: string,
  id: string,
  label: string,
  log: Log,
): Promise<boolean> {
  try {
    await cli.run(["item", "delete", id, "--vault", vaultId]);
    return true;
  } catch (error) {
    log(`${label} delete error=${codeOf(error)}`);
    return false;
  }
}

export async function syncLane(
  cli: OpCli,
  config: BrokerConfig,
  lane: string,
  titles: string[],
  log: Log,
): Promise<LaneSync> {
  const vaultId = await ensureLaneVault(cli, lane);
  const before = await listItems(cli, vaultId);
  const keep = new Set<string>();
  for (const item of before) if (!(item.tags ?? []).includes(SYNCED_TAG)) keep.add(item.id);
  let copied = 0;
  let failed = 0;
  for (const title of titles) {
    try {
      if (before.some((i) => i.title === title && !(i.tags ?? []).includes(SYNCED_TAG))) {
        throw new BrokerError("BAD_REQUEST", "a lane-owned item already has this title");
      }
      const source = JSON.parse(
        await cli.run(["item", "get", title, "--vault", config.sourceVault, "--format", "json"], {
          reads: 3,
        }),
      ) as SourceItem;
      if (source.title !== title) throw new BrokerError("ITEM_NOT_FOUND", "no item has exactly this title");
      keep.add(await createItem(cli, vaultId, copyTemplate(source)));
      copied += 1;
      log(`sync lane=${lane} item=${title} ok`);
    } catch (error) {
      failed += 1;
      for (const old of before) if (old.title === title) keep.add(old.id);
      log(`sync lane=${lane} item=${title} error=${codeOf(error)}`);
    }
  }
  let removed = 0;
  for (const old of before) {
    if (keep.has(old.id)) continue;
    const label = `sync lane=${lane} item=${old.title}`;
    if (await deleteItem(cli, vaultId, old.id, label, log)) removed += 1;
  }
  return { copied, failed, removed };
}

interface LoginImport {
  title: string;
  username: string;
  url: string;
  password: string;
}

export async function importLogin(
  cli: OpCli,
  config: BrokerConfig,
  lane: string,
  login: LoginImport,
  log: Log,
): Promise<string> {
  if (!(lane in config.lanes))
    throw new BrokerError("NOT_ALLOWED", `lane ${lane} is not set up in the credential broker`);
  if ((config.lanes[lane] ?? []).includes(login.title)) {
    throw new BrokerError(
      "BAD_REQUEST",
      "this title is on the lane's Personal list; it would be overwritten by the sync",
    );
  }
  if (!login.title || !login.username || !login.password)
    throw new BrokerError("BAD_REQUEST", "title, username and password are required");
  if (!/^https:\/\/[^/\s]+/.test(login.url))
    throw new BrokerError("BAD_REQUEST", "the website must be an https URL");
  const vaultId = await ensureLaneVault(cli, lane);
  const before = await listItems(cli, vaultId);
  const created = await createItem(cli, vaultId, {
    title: login.title,
    category: "LOGIN",
    tags: [LANE_OWNED_TAG],
    fields: [
      { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: login.username },
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: login.password },
    ],
    urls: [{ label: "website", primary: true, href: login.url }],
  });
  for (const old of before) {
    if (old.title === login.title && old.id !== created) {
      await deleteItem(cli, vaultId, old.id, `import lane=${lane} item=${login.title}`, log);
    }
  }
  return laneVaultName(lane);
}
