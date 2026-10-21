import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./lane-config.ts";

export interface MemoryOptions {
  readonly seed?: string;
  readonly source?: string;
  readonly compactor?: string;
  readonly thinking?: string;
}

const PACKAGE = join("config", "optchat", "package");
const MEMORY_HOME = join("data", "optchat");
const SOCKET_PATH_LIMIT = process.platform === "darwin" ? 103 : 107;

const run = (file: string, args: readonly string[], cwd?: string): string =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd }).trim();

const agentDir = (): string =>
  process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");

function fetchPublished(helperDir: string, into: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(helperDir, "manifest.json"), "utf8"));
  const name = isRecord(manifest) ? manifest["package"] : undefined;
  const version = isRecord(manifest) ? manifest["version"] : undefined;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`${join(helperDir, "manifest.json")} names no package and version`);
  }
  const tarball = run("npm", [
    "pack",
    `${name}@${version}`,
    "--silent",
    "--pack-destination",
    into,
  ]);
  run("tar", ["-xzf", join(into, tarball.split("\n").at(-1) ?? ""), "-C", into]);
  return join(into, "package");
}

function preparePackage(home: string, source: string | undefined): string {
  const target = join(home, PACKAGE);
  if (existsSync(target)) return `package: ${PACKAGE} is there already`;
  const helper = realpathSync(join(agentDir(), "optchat", "package.mjs"));
  const scratch = mkdtempSync(join(tmpdir(), "fleet-optchat-"));
  try {
    const published = source ?? fetchPublished(join(helper, ".."), scratch);
    run("node", [helper, "prepare", published, target]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return `package: prepared in ${PACKAGE}`;
}

function makeProfile(home: string, lane: string, options: MemoryOptions): string {
  const profile = join(home, MEMORY_HOME, "profiles", lane);
  const socket = join(realpathSync(home), MEMORY_HOME, "profiles", lane, "lock.sock");
  if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) {
    throw new Error(
      `the profile's socket path is longer than ${String(SOCKET_PATH_LIMIT)} bytes: ${socket}`,
    );
  }
  if (existsSync(join(profile, "AGENTS.md"))) return `profile: ${lane} is there already`;
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (options.seed !== undefined) {
    for (const file of ["AGENTS.md", "config.json"]) {
      copyFileSync(join(options.seed, file), join(profile, file));
    }
    return `profile: ${lane}, from ${options.seed}`;
  }
  const [provider = "pending", model = "pending"] = options.compactor?.split("/") ?? [];
  const choice = { provider, model, thinking: options.thinking ?? "low" };
  const settings = { compactor: choice, subagent: { ...choice, thinking: "off" } };
  writeFileSync(join(profile, "config.json"), `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    join(profile, "AGENTS.md"),
    `# ${lane}\n\nThe ${lane} mate's conversation recall. The fleet's role contract, the lane's charter, and the cards remain authoritative.\n`,
    { mode: 0o600 },
  );
  return `profile: ${lane}, new`;
}

function writeSettings(home: string, lane: string, options: MemoryOptions): string {
  const file = join(home, "config", "optchat.json");
  if (existsSync(file)) {
    const found: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(found)) throw new Error(`${file} is not a JSON object`);
    if (found["enabled"] !== false) return "settings: config/optchat.json is there already";
    writeFileSync(file, `${JSON.stringify({ ...found, enabled: true }, null, 2)}\n`, {
      mode: 0o600,
    });
    return "settings: turned memory on in config/optchat.json";
  }
  const [provider, model] = options.compactor?.split("/") ?? [];
  const settings = {
    enabled: true,
    package: PACKAGE,
    memoryHome: MEMORY_HOME,
    profile: lane,
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(model === undefined ? {} : { compactorModel: model }),
    ...(provider === undefined || model === undefined ? {} : { compactorProvider: provider }),
  };
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return "settings: wrote config/optchat.json";
}

export function setUpMemory(home: string, lane: string, options: MemoryOptions): string[] {
  const loader = join(agentDir(), "extensions", "fm-optchat", "index.ts");
  if (!existsSync(loader)) throw new Error(`${loader} is missing: install the memory loader first`);
  if (options.compactor !== undefined && !/^[^/]+\/[^/]+$/.test(options.compactor)) {
    throw new Error("--compactor is provider/model, such as tier/compact");
  }
  return [
    preparePackage(home, options.source),
    makeProfile(home, lane, options),
    writeSettings(home, lane, options),
  ];
}
