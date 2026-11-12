import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

export const YAZI_VERSION = "26.5.6";

interface Asset {
  readonly target: string;
  readonly sha256: string;
}

const ASSETS: Readonly<Record<string, Asset>> = {
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    sha256: "7abd71725e2fe27bed036becbf6ce79fa17964eb68491d34190011c94b8c7ca8",
  },
  "darwin-x64": {
    target: "x86_64-apple-darwin",
    sha256: "6846066f992c1688d8ec77431a3ab53f5ef268019fcef86e5649b8c27010868d",
  },
  "linux-x64": {
    target: "x86_64-unknown-linux-musl",
    sha256: "1031a02560d053301537195a6661d227c15cb4ce5c30481050b31e2b88681bff",
  },
  "linux-arm64": {
    target: "aarch64-unknown-linux-musl",
    sha256: "dff4a6774069bdde616c3cd145275b462a5887229cd9bf6341e78063da37e84f",
  },
};

const BINARIES: readonly string[] = ["yazi", "ya"];
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const DEFLATE = 8;

const platformKey = (): string => `${process.platform}-${process.arch}`;

const cacheRoot = (): string => {
  const named = process.env["XDG_CACHE_HOME"];
  return join(named !== undefined && named !== "" ? named : join(homedir(), ".cache"), "fleet");
};

const releaseDir = (): string => join(cacheRoot(), `yazi-${YAZI_VERSION}-${platformKey()}`);

const complete = (dir: string): boolean => BINARIES.every((name) => existsSync(join(dir, name)));

function endOfDirectory(zip: Buffer): number {
  for (let at = zip.length - 22; at >= 0; at -= 1) {
    if (zip.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  }
  throw new Error("the yazi release is not a zip file");
}

function entryData(zip: Buffer, entry: number): Buffer {
  const method = zip.readUInt16LE(entry + 10);
  const packed = zip.readUInt32LE(entry + 20);
  const local = zip.readUInt32LE(entry + 42);
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + packed);
  return method === DEFLATE ? inflateRawSync(data) : Buffer.from(data);
}

function binariesIn(zip: Buffer): Map<string, Buffer> {
  const end = endOfDirectory(zip);
  const count = zip.readUInt16LE(end + 10);
  const found = new Map<string, Buffer>();
  let entry = zip.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(entry) !== DIRECTORY_ENTRY) break;
    const nameLength = zip.readUInt16LE(entry + 28);
    const name = zip.toString("utf8", entry + 46, entry + 46 + nameLength);
    const base = name.split("/").at(-1) ?? "";
    if (BINARIES.includes(base)) found.set(base, entryData(zip, entry));
    entry += 46 + nameLength + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32);
  }
  return found;
}

function unpack(zip: Buffer, dir: string): void {
  const found = binariesIn(zip);
  const staging = `${dir}.part-${String(process.pid)}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const name of BINARIES) {
    const body = found.get(name);
    if (body === undefined) throw new Error(`the yazi release has no ${name}`);
    writeFileSync(join(staging, name), body);
    chmodSync(join(staging, name), 0o755);
  }
  try {
    renameSync(staging, dir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!complete(dir)) throw error;
  }
}

async function download(asset: Asset): Promise<Buffer> {
  const url = `https://github.com/sxyazi/yazi/releases/download/v${YAZI_VERSION}/yazi-${asset.target}.zip`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
  const zip = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(zip).digest("hex");
  if (digest !== asset.sha256)
    throw new Error(`${url} has sha256 ${digest}, not the pinned ${asset.sha256}`);
  return zip;
}

export async function pinnedYazi(): Promise<string> {
  const dir = releaseDir();
  if (complete(dir)) return dir;
  const asset = ASSETS[platformKey()];
  if (asset === undefined) throw new Error(`no yazi release is pinned for ${platformKey()}`);
  console.log(`fleet files: fetching yazi ${YAZI_VERSION} for this host, once, into ${dir}`);
  mkdirSync(cacheRoot(), { recursive: true });
  unpack(await download(asset), dir);
  return dir;
}
