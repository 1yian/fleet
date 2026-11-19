import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrokerErrorCode } from "../shared/broker-protocol.js";
import type { BrokerConfig } from "./config.js";
import { ReadLedger } from "./ledger.js";

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  constructor(code: BrokerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

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

const LANE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class OnePassword {
  private readonly config: BrokerConfig;
  private readonly ledger: ReadLedger;
  private readonly refsPath: string;
  private refs: Record<string, ItemRefs>;
  private readonly cache = new Map<string, { at: number; data: ItemData }>();

  constructor(config: BrokerConfig) {
    this.config = config;
    this.ledger = new ReadLedger(config.stateDir);
    this.refsPath = join(config.stateDir, "refs.json");
    this.refs = existsSync(this.refsPath)
      ? (JSON.parse(readFileSync(this.refsPath, "utf8")) as Record<string, ItemRefs>)
      : {};
  }

  readsLast24h(): number {
    return this.ledger.used();
  }

  async item(lane: string, itemName: string, cacheMs = 0): Promise<ItemData> {
    const key = `${lane}/${itemName}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < cacheMs) return cached.data;
    const known = this.refs[key];
    const args = known
      ? ["item", "get", known.itemId, "--vault", known.vaultId, "--format", "json"]
      : ["item", "get", itemName, "--vault", `fleet-browser-${lane}`, "--format", "json"];
    const reads = known ? 1 : 3;
    if (this.ledger.used() + reads > this.config.dailyReadBudget) {
      throw new BrokerError(
        "BUDGET",
        `the local daily budget of ${this.config.dailyReadBudget} 1Password reads is used up; retry later`,
      );
    }
    const stdout = await this.run(lane, args, reads);
    const item = JSON.parse(stdout) as OpItem;
    if (!known) {
      this.refs[key] = { itemId: item.id, vaultId: item.vault.id };
      const temp = `${this.refsPath}.tmp`;
      writeFileSync(temp, JSON.stringify(this.refs), { mode: 0o600 });
      renameSync(temp, this.refsPath);
    }
    const data = this.parse(item);
    if (cacheMs > 0) this.cache.set(key, { at: Date.now(), data });
    return data;
  }

  async ratelimit(lane: string): Promise<string> {
    return (await this.run(lane, ["service-account", "ratelimit"], 1)).trim();
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

  private token(lane: string): string {
    if (!LANE_PATTERN.test(lane)) throw new BrokerError("BAD_REQUEST", "invalid lane name");
    const path = join(this.config.tokenDir, `${lane}.token`);
    if (!existsSync(path))
      throw new BrokerError("NO_TOKEN", `no 1Password service account token is installed for lane ${lane}`);
    return readFileSync(path, "utf8").trim();
  }

  private run(lane: string, args: string[], reads: number): Promise<string> {
    const token = this.token(lane);
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.opPath, args, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: this.config.stateDir,
          OP_SERVICE_ACCOUNT_TOKEN: token,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new BrokerError("OP_ERROR", `could not run the 1Password CLI: ${error.message}`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.ledger.record(reads);
        if (code === 0) resolve(stdout);
        else reject(this.mapError(stderr));
      });
    });
  }

  private mapError(stderr: string): BrokerError {
    const line = (stderr.split("\n").find((l) => l.includes("[ERROR]")) ?? stderr)
      .replace(/^\[ERROR\]\s+\S+\s+\S+\s+/, "")
      .trim();
    if (/429|Too Many Requests/i.test(line)) return new BrokerError("RATE_LIMITED", line.slice(0, 200));
    if (/isn't an item|isn.t a vault|not found|no item/i.test(line))
      return new BrokerError("ITEM_NOT_FOUND", line.slice(0, 200));
    if (/DecodeSACredentials|invalid.*token|authenticat|unauthori[sz]ed|service account/i.test(line)) {
      return new BrokerError("BAD_TOKEN", "the lane's 1Password service account token was rejected");
    }
    return new BrokerError("OP_ERROR", line.slice(0, 200));
  }
}
