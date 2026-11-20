import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrokerConfig, LANE_PATTERN, laneVaultName } from "./config.js";
import { BrokerError } from "./errors.js";
import { ReadLedger } from "./ledger.js";
import { OpCli } from "./opcli.js";

interface ItemRefs {
  itemId: string;
  vaultId: string;
}

interface OpField {
  id?: string;
  label?: string;
  type?: string;
  purpose?: string;
  value?: string;
  totp?: string;
}

interface OpItem {
  id: string;
  vault: { id: string };
  urls?: Array<{ href?: string }>;
  fields?: OpField[];
}

export interface ItemData {
  username: string | null;
  password: string | null;
  totp: string | null;
  urls: string[];
  fields: Map<string, string>;
}

export class OnePassword {
  private readonly config: BrokerConfig;
  private readonly ledger: ReadLedger;
  private readonly cli: OpCli;
  private readonly refsPath: string;
  private refs: Record<string, ItemRefs>;
  private readonly cache = new Map<string, { at: number; data: ItemData }>();

  constructor(config: BrokerConfig, token: string) {
    this.config = config;
    this.ledger = new ReadLedger(config.stateDir);
    this.cli = new OpCli(config.opPath, token, config.stateDir, (reads) => this.ledger.record(reads));
    this.refsPath = join(config.stateDir, "refs.json");
    this.refs = existsSync(this.refsPath)
      ? (JSON.parse(readFileSync(this.refsPath, "utf8")) as Record<string, ItemRefs>)
      : {};
  }

  get opCli(): OpCli {
    return this.cli;
  }

  readsLast24h(): number {
    return this.ledger.used();
  }

  async item(lane: string, itemName: string, cacheMs = 0): Promise<ItemData> {
    if (!LANE_PATTERN.test(lane)) throw new BrokerError("BAD_REQUEST", "invalid lane name");
    if (!(lane in this.config.lanes)) {
      throw new BrokerError("NOT_ALLOWED", `lane ${lane} is not set up in the credential broker`);
    }
    if (itemName.startsWith("-") || itemName.includes("://")) {
      throw new BrokerError("BAD_REQUEST", "invalid item name");
    }
    const key = `${lane}/${itemName}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < cacheMs) return cached.data;
    const known = this.refs[key];
    let item: OpItem;
    if (known) {
      try {
        item = await this.fetch(
          ["item", "get", known.itemId, "--vault", known.vaultId, "--format", "json"],
          1,
        );
      } catch (error) {
        if (!(error instanceof BrokerError) || error.code !== "ITEM_NOT_FOUND") throw error;
        delete this.refs[key];
        item = await this.fetchByName(lane, itemName, key);
      }
    } else {
      item = await this.fetchByName(lane, itemName, key);
    }
    const data = this.parse(item);
    if (cacheMs > 0) this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  private async fetchByName(lane: string, itemName: string, key: string): Promise<OpItem> {
    const item = await this.fetch(
      ["item", "get", itemName, "--vault", laneVaultName(lane), "--format", "json"],
      3,
    );
    this.refs[key] = { itemId: item.id, vaultId: item.vault.id };
    this.saveRefs();
    return item;
  }

  private async fetch(args: string[], reads: number): Promise<OpItem> {
    if (this.ledger.used() + reads > this.config.dailyReadBudget) {
      throw new BrokerError(
        "BUDGET",
        `the local daily budget of ${this.config.dailyReadBudget} 1Password reads is used up; retry later`,
      );
    }
    return JSON.parse(await this.cli.run(args, { reads })) as OpItem;
  }

  async ratelimit(): Promise<string> {
    return (await this.cli.run(["service-account", "ratelimit"])).trim();
  }

  private saveRefs(): void {
    const temp = `${this.refsPath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.refs), { mode: 0o600 });
    renameSync(temp, this.refsPath);
  }

  private parse(item: OpItem): ItemData {
    const fields = new Map<string, string>();
    let username: string | null = null;
    let password: string | null = null;
    let totp: string | null = null;
    for (const field of item.fields ?? []) {
      if (field.type === "OTP") {
        totp = field.totp ?? totp;
        continue;
      }
      if (field.value === undefined || field.value === "") continue;
      if (field.purpose === "USERNAME") username = field.value;
      else if (field.purpose === "PASSWORD") password = field.value;
      if (field.label) fields.set(field.label.toLowerCase(), field.value);
    }
    username ??= fields.get("username") ?? null;
    password ??= fields.get("password") ?? null;
    const urls = (item.urls ?? [])
      .map((u) => u.href)
      .filter((href): href is string => typeof href === "string");
    return { username, password, totp, urls, fields };
  }
}
