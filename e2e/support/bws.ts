import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecord, type JsonRecord } from "./json.ts";
import { tempDir } from "./run-root.ts";

const FAKE = fileURLToPath(new URL("./fake-bws.ts", import.meta.url));

export interface FakeProject {
  readonly name: string;
  readonly secrets: Readonly<Record<string, string>>;
}

interface Call {
  readonly args: string[];
  readonly token: boolean;
}

export class FakeBws {
  readonly accessToken = `0.${randomUUID()}.fake-machine-account`;
  private readonly dir = tempDir("fleet-bws-");
  readonly tokenFile = join(this.dir, "lane.token");
  private readonly log = join(this.dir, "calls.log");
  private readonly projects: readonly {
    id: string;
    name: string;
    secrets: { id: string; key: string; value: string }[];
  }[];
  private outage: string | undefined;

  constructor(projects: readonly FakeProject[]) {
    this.projects = projects.map(({ name, secrets }) => ({
      id: randomUUID(),
      name,
      secrets: Object.entries(secrets).map(([key, value]) => ({ id: randomUUID(), key, value })),
    }));
    const shim = join(this.dir, "bws");
    writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(FAKE)} "$@"\n`);
    chmodSync(shim, 0o755);
    writeFileSync(this.tokenFile, this.accessToken);
    chmodSync(this.tokenFile, 0o600);
  }

  failWith(message: string): void {
    this.outage = message;
  }

  secretId(project: string, key: string): string {
    const id = this.projects
      .find((each) => each.name === project)
      ?.secrets.find((each) => each.key === key)?.id;
    if (id === undefined) throw new Error(`no secret ${key} in project ${project}`);
    return id;
  }

  get env(): Record<string, string> {
    const data = {
      token: this.accessToken,
      ...(this.outage === undefined ? {} : { outage: this.outage }),
      projects: this.projects,
    };
    return {
      PATH: `${this.dir}:${process.env["PATH"] ?? ""}`,
      FAKE_BWS_DATA: JSON.stringify(data),
      FAKE_BWS_LOG: this.log,
    };
  }

  calls(): Call[] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => callOf(parseRecord(line)));
  }
}

function callOf(record: JsonRecord): Call {
  const args = record["args"];
  return {
    args: Array.isArray(args) ? args.map(String) : [],
    token: record["token"] === true,
  };
}

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function filesUnder(dir: string): string[] {
  return entriesOf(dir).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

function holds(path: string, needle: string): boolean {
  try {
    return readFileSync(path).includes(needle);
  } catch {
    return false;
  }
}

export function filesHolding(needle: string, root = tmpdir()): string[] {
  return filesUnder(root).filter((path) => holds(path, needle));
}
