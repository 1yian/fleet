import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { isRecord } from "../lane-config.ts";
import type { BridgeConfig } from "./config.ts";
import { describeError, type Log } from "./log.ts";

const REQUEST_MS = 30_000;
const TRANSFER_MS = 120_000;
const RATE_LIMIT_RETRIES = 5;
const DEFAULT_RETRY_MS = 1_000;
const RETRY_MARGIN_MS = 250;
const POLL_LIMIT = 10;
const EMPTY_CHANNEL = "0";

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function retryDelay(response: Response): Promise<number> {
  try {
    const body: unknown = JSON.parse(await response.text());
    const seconds = isRecord(body) ? body["retry_after"] : undefined;
    return typeof seconds === "number"
      ? Math.ceil(seconds * 1000) + RETRY_MARGIN_MS
      : DEFAULT_RETRY_MS;
  } catch {
    return DEFAULT_RETRY_MS;
  }
}

export class Discord {
  private readonly base: string;
  private readonly channel: string;
  private readonly authorization: string;
  private readonly log: Log;

  constructor(config: Pick<BridgeConfig, "token" | "channel" | "discordUrl">, log: Log) {
    this.base = config.discordUrl;
    this.channel = config.channel;
    this.authorization = `Bot ${config.token}`;
    this.log = log;
  }

  private async get(path: string): Promise<unknown> {
    try {
      const response = await fetch(`${this.base}${path}`, {
        headers: { Authorization: this.authorization },
        signal: AbortSignal.timeout(REQUEST_MS),
      });
      if (!response.ok) {
        this.log(`GET ${path} failed with HTTP ${String(response.status)}`);
        return undefined;
      }
      const body: unknown = await response.json();
      return body;
    } catch (error) {
      this.log(`GET ${path} failed: ${describeError(error)}`);
      return undefined;
    }
  }

  private async post(path: string, request: () => RequestInit): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.base}${path}`, request());
      if (response.status !== 429) {
        await response.text();
        if (!response.ok)
          throw new Error(`POST ${path} failed with HTTP ${String(response.status)}`);
        return;
      }
      if (attempt >= RATE_LIMIT_RETRIES)
        throw new Error(`POST ${path} was rate limited ${String(attempt + 1)} times`);
      await pause(await retryDelay(response));
    }
  }

  private json(payload: unknown): () => RequestInit {
    return () => ({
      method: "POST",
      headers: { Authorization: this.authorization, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
  }

  async me(): Promise<string | undefined> {
    const body = await this.get("/users/@me");
    return isRecord(body) && typeof body["id"] === "string" ? body["id"] : undefined;
  }

  async channelGuild(): Promise<string | undefined> {
    const body = await this.get(`/channels/${this.channel}`);
    return isRecord(body) && typeof body["guild_id"] === "string" ? body["guild_id"] : undefined;
  }

  async newestId(): Promise<string | undefined> {
    const body = await this.get(`/channels/${this.channel}/messages?limit=1`);
    if (!Array.isArray(body)) return undefined;
    const newest: unknown = body[0];
    if (newest === undefined) return EMPTY_CHANNEL;
    return isRecord(newest) && typeof newest["id"] === "string" ? newest["id"] : undefined;
  }

  async messagesAfter(cursor: string): Promise<readonly unknown[]> {
    const body = await this.get(
      `/channels/${this.channel}/messages?after=${cursor}&limit=${String(POLL_LIMIT)}`,
    );
    return Array.isArray(body) ? body.map((item: unknown) => item) : [];
  }

  async say(text: string): Promise<void> {
    await this.post(`/channels/${this.channel}/messages`, this.json({ content: text }));
  }

  async typing(): Promise<void> {
    try {
      await this.post(`/channels/${this.channel}/typing`, this.json({}));
    } catch (error) {
      this.log(`the typing indicator failed: ${describeError(error)}`);
    }
  }

  async upload(file: string, caption: string): Promise<boolean> {
    try {
      const bytes = readFileSync(file);
      const request = (): RequestInit => {
        const form = new FormData();
        if (caption !== "") form.append("payload_json", JSON.stringify({ content: caption }));
        form.append("files[0]", new Blob([bytes]), basename(file));
        return {
          method: "POST",
          headers: { Authorization: this.authorization },
          body: form,
          signal: AbortSignal.timeout(TRANSFER_MS),
        };
      };
      await this.post(`/channels/${this.channel}/messages`, request);
      return true;
    } catch (error) {
      this.log(`uploading ${basename(file)} failed: ${describeError(error)}`);
      return false;
    }
  }

  async download(url: string): Promise<Buffer | undefined> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TRANSFER_MS) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      this.log(`downloading an attachment failed with HTTP ${String(response.status)}`);
    } catch (error) {
      this.log(`downloading an attachment failed: ${describeError(error)}`);
    }
    return undefined;
  }
}
