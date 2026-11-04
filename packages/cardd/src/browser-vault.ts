import { execFile } from "node:child_process";
import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import type { LoginsConfig } from "./browser-config.ts";
import type { Credentials } from "./browser-fill.ts";
import { isRecord } from "./browser-hidden.ts";
import type { Hosts } from "./pulls.ts";

const BWS_TIMEOUT_MS = 30_000;
const BWS_OUTPUT_BYTES = 16 * 1024 * 1024;
const OPENED_WINDOW_MS = 60_000;

const SecretsSchema = Type.Array(
  Type.Object({ id: Type.String(), key: Type.String(), value: Type.String() }),
);
const CredentialsSchema = Type.Object({
  username: Type.String({ minLength: 1 }),
  password: Type.String({ minLength: 1 }),
  totp: Type.Optional(Type.String({ minLength: 1 })),
});

export interface Secret {
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

export function credentialsOf(entry: Secret): Credentials {
  try {
    return parseCdp(CredentialsSchema, JSON.parse(entry.value), "the entry");
  } catch {
    throw new Error(
      `the Bitwarden entry ${entry.key} is not usable: its value must be JSON like {"username": "...", "password": "..."}. Its content is not shown`,
    );
  }
}

const FIELDS = ["username", "password", "totp"] as const;

function parsedOf(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;

const absent = (value: unknown): boolean => value === undefined || value === null;

function protectedIn(entry: Secret): { values: string[]; known: boolean } {
  const record = parsedOf(entry.value)?.value;
  if (!entry.value.trimStart().startsWith("{"))
    return {
      values: typeof record === "string" ? [entry.value, record] : [entry.value],
      known: true,
    };
  if (!isRecord(record)) return { values: [entry.value], known: false };
  const fields = FIELDS.map((field) => record[field]);
  return {
    values: fields.flatMap((value) => textOf(value) ?? []),
    known: fields.every((value) => textOf(value) !== undefined || absent(value)),
  };
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class Vault {
  readonly logins: LoginsConfig | undefined;
  private readonly hosts: Hosts;
  private readonly held = new Set<string>();
  private readonly opened = new Map<string, number>();
  private loaded = false;

  constructor(logins: LoginsConfig | undefined, hosts: Hosts) {
    this.logins = logins;
    this.hosts = hosts;
  }

  get values(): string[] {
    return [...this.held];
  }

  async refresh(): Promise<Secret[]> {
    if (this.logins === undefined) return [];
    this.loaded = false;
    const secrets = await listSecrets(this.logins, this.hosts);
    const unknown: string[] = [];
    for (const secret of secrets) {
      const { values, known } = protectedIn(secret);
      for (const value of values) this.held.add(value);
      if (!known) unknown.push(secret.key);
    }
    if (unknown.length > 0)
      throw new Error(
        `the Bitwarden entry ${unknown.join(", ")} is malformed: it must be JSON like {"username": "...", "password": "..."} with each field text or empty, so the values to hide are not known. Fix the entry. Its content is not shown`,
      );
    this.loaded = true;
    this.opened.clear();
    return secrets;
  }

  async ready(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async beforeOpening(host: string): Promise<void> {
    const at = this.opened.get(host);
    if (!this.loaded || at === undefined || Date.now() - at > OPENED_WINDOW_MS) await this.load();
    if (this.logins !== undefined) this.opened.set(host, Date.now());
  }

  private async load(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      throw new Error(
        `the Logins project could not be read to learn which values to hide, so nothing was done: ${reason(error)}. Try again when the vault answers`,
        { cause: error },
      );
    }
  }
}
