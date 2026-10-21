// Turns on conversation memory (optchat) in a lane home, the same way for main and for each second
// mate (docs/setup.md). The memory loader is the user's own fm-optchat extension, and optchat.ts
// loads it when the home has config/optchat.json. This writes what the loader reads, all inside the
// one home: the pinned pi-optchat package, prepared by the loader's own helper, in
// config/optchat/package; the lane's profile in data/optchat/profiles/<lane>; and config/optchat.json.
// Each step that is done already is left alone, so running it again changes nothing.
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
  /** A profile folder to start from, such as the lane's old Firstmate profile. Only its AGENTS.md and config.json are copied. */
  readonly seed?: string;
  /** A published pi-optchat folder to prepare the package from. Without it, npm fetches the pinned version. */
  readonly source?: string;
  /** The memory's compactor model as provider/model. Without it, the memory uses the mate's own model. */
  readonly compactor?: string;
  /** The compactor's thinking level. */
  readonly thinking?: string;
}

const PACKAGE = join("config", "optchat", "package");
const MEMORY_HOME = join("data", "optchat");
// The profile's lock socket must fit in a socket path: 104 bytes on macOS and 108 elsewhere, with the NUL.
const SOCKET_PATH_LIMIT = process.platform === "darwin" ? 103 : 107;

const run = (file: string, args: readonly string[], cwd?: string): string =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd }).trim();

/** The Pi agent folder: where the loader and its package helper are installed. */
const agentDir = (): string =>
  process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");

/** Fetches the published package that the helper's manifest pins, into a folder that the caller removes. */
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

/** Prepares the pinned package into the home with the loader's helper, which checks every file. */
function preparePackage(home: string, source: string | undefined): string {
  const target = join(home, PACKAGE);
  if (existsSync(target)) return `package: ${PACKAGE} is there already`;
  // The helper runs only when its path is its real path.
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

/** The lane's profile: copied from a seed, or new. The loader sets its models again at every start. */
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
  if (existsSync(file)) return "settings: config/optchat.json is there already";
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

/** Sets up memory in the lane's home and says what it did. The mate gets it at its next start. */
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
