import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

export interface BwsConfig {
  readonly tokenFile: string;
  readonly project: string;
  readonly common?: string;
  readonly laneToken?: string;
  readonly env: Readonly<Record<string, string>>;
}

export type Lookup =
  | { readonly found: true; readonly value: string; readonly where: string }
  | { readonly found: false; readonly why: string };

export interface Fallback {
  readonly value: string | undefined;
  readonly from: string;
}

export interface Resolved {
  readonly value: string | undefined;
  readonly note: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BWS_TIMEOUT_MS = 20_000;
const WHY_LIMIT = 160;

export const isUuid = (text: string): boolean => UUID.test(text);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const listOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.map((each: unknown) => each) : [];

const textOf = (value: unknown, key: string): string | undefined => {
  const found = isRecord(value) ? value[key] : undefined;
  return typeof found === "string" ? found : undefined;
};

class Failure extends Error {}

function firstLine(text: string, hide: string): string {
  const line = text.split("\n").find((each) => each.trim() !== "") ?? "";
  const shown = line.trim().replaceAll(hide, "[hidden]");
  return shown.length > WHY_LIMIT ? `${shown.slice(0, WHY_LIMIT)}...` : shown;
}

function describeFailure(
  error: { code?: unknown; killed?: unknown },
  stderr: string,
  token: string,
): string {
  if (error.code === "ENOENT") return "bws is not on the PATH";
  if (error.killed === true) return `bws did not answer within ${String(BWS_TIMEOUT_MS / 1000)}s`;
  const detail = firstLine(stderr, token);
  return `bws exited with status ${String(error.code)}${detail === "" ? "" : `: ${detail}`}`;
}

export class Bws {
  private readonly config: BwsConfig;
  private token: string | undefined;
  private readonly lists = new Map<string, Promise<unknown>>();

  constructor(config: BwsConfig) {
    this.config = config;
  }

  async lookup(reference: string): Promise<Lookup> {
    try {
      return await this.find(reference);
    } catch (error) {
      if (error instanceof Failure) return { found: false, why: error.message };
      throw error;
    }
  }

  private accessToken(): string {
    if (this.token !== undefined) return this.token;
    const file = this.config.tokenFile.replace(/^~(?=\/|$)/, homedir());
    let mode: number;
    let text: string;
    try {
      mode = statSync(file).mode;
      text = readFileSync(file, "utf8").trim();
    } catch {
      throw new Failure(`the token file ${this.config.tokenFile} is missing or unreadable`);
    }
    if ((mode & 0o077) !== 0)
      throw new Failure(`the token file ${this.config.tokenFile} must be mode 600`);
    if (text === "") throw new Failure(`the token file ${this.config.tokenFile} is empty`);
    this.token = text;
    return text;
  }

  private async run(args: readonly string[]): Promise<unknown> {
    const token = this.accessToken();
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "bws",
        ["--color", "no", "--output", "json", ...args],
        {
          encoding: "utf8",
          timeout: BWS_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, BWS_ACCESS_TOKEN: token },
        },
        (error, out, err) => {
          if (error === null) resolve(out);
          else reject(new Failure(describeFailure(error, err, token)));
        },
      );
    });
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Failure("bws printed something that is not JSON");
    }
  }

  private async find(reference: string): Promise<Lookup> {
    if (isUuid(reference)) {
      const value = textOf(await this.run(["secret", "get", reference]), "value");
      return value === undefined
        ? { found: false, why: `secret ${reference} has no value` }
        : { found: true, value, where: `secret id ${reference}` };
    }
    const tried: string[] = [];
    for (const project of [this.config.project, this.config.common]) {
      if (project === undefined) continue;
      const hit = listOf(await this.secretsOf(project)).find(
        (each) => textOf(each, "key") === reference,
      );
      const value = textOf(hit, "value");
      if (value !== undefined)
        return { found: true, value, where: `key ${reference} in project ${project}` };
      tried.push(`no key ${reference} in project ${project}`);
    }
    return { found: false, why: tried.join(", ") };
  }

  private secretsOf(project: string): Promise<unknown> {
    const known = this.lists.get(project);
    if (known !== undefined) return known;
    const fresh = this.run(["secret", "list", project]);
    this.lists.set(project, fresh);
    return fresh;
  }
}

export async function resolveSecret(
  bws: Bws | undefined,
  name: string,
  reference: string,
  fallback: Fallback,
): Promise<Resolved> {
  const tried = bws === undefined ? undefined : await bws.lookup(reference);
  if (tried?.found === true)
    return { value: tried.value, note: `${name}: from bws (${tried.where})` };
  const why = tried === undefined ? "bws is not configured" : `bws failed: ${tried.why}`;
  return fallback.value === undefined
    ? { value: undefined, note: `${name}: not found (${why}, and ${fallback.from} has none)` }
    : { value: fallback.value, note: `${name}: from ${fallback.from} (${why})` };
}
