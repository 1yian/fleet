import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_BWS = fileURLToPath(new URL("./fake-bws", import.meta.url));

const PROJECT_ID = "6c1f5a43-0b6e-4c53-9d58-2f0d6a1f7e11";
const TOKEN = "0.fake-machine-account-token.not-a-real-token";

export interface VaultEntry {
  readonly key: string;
  readonly value: string;
}

export class FakeVault {
  readonly dir: string;
  readonly tokenFile: string;

  constructor(entries: readonly VaultEntry[]) {
    this.dir = mkdtempSync("/tmp/fleet-fake-vault-");
    this.tokenFile = join(this.dir, "browser-logins.token");
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "token"), TOKEN);
    writeFileSync(this.tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    writeFileSync(join(this.dir, "project"), PROJECT_ID);
    writeFileSync(join(this.dir, "invocations"), "");
    this.publish(entries);
  }

  publish(entries: readonly VaultEntry[]): void {
    const secrets = entries.map((entry, index) => ({
      id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      projectId: PROJECT_ID,
      ...entry,
    }));
    writeFileSync(join(this.dir, "secrets.json"), JSON.stringify(secrets));
  }

  revoke(): void {
    writeFileSync(this.tokenFile, "0.a-token-the-vault-does-not-know\n");
  }

  restore(): void {
    writeFileSync(this.tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  }

  hold(): void {
    execFileSync("mkfifo", [join(this.dir, "gate")]);
  }

  async release(): Promise<void> {
    const gate = join(this.dir, "gate");
    await writeFile(gate, "go\n");
    rmSync(gate, { force: true });
  }

  get env(): Record<string, string> {
    return {
      PATH: `${FAKE_BWS}${delimiter}${process.env["PATH"] ?? ""}`,
      FAKE_BWS_DIR: this.dir,
    };
  }

  config(cdp: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      cdp,
      logins: { host: "p620", tokenFile: this.tokenFile, project: PROJECT_ID, ...extra },
    });
  }

  invocations(): string[] {
    return readFileSync(join(this.dir, "invocations"), "utf8")
      .split("\n")
      .filter((line) => line !== "");
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
