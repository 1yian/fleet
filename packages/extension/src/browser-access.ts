import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { check } from "@fleet/protocol";
import { readLaneConfig, strings, type LaneConfig } from "./lane-config.ts";
import { bwsFor, laneToken } from "./lane-secrets.ts";

const URL_VARIABLE = "FLEET_BROWSER_URL";
const TOKEN_VARIABLE = "FLEET_BROWSER_TOKEN";
const HOME_VARIABLE = "FLEET_BROWSER_HOME";

const AccessSchema = Type.Object({
  url: Type.String(),
  token: Type.String(),
  host: Type.Optional(Type.String()),
});

export interface Access {
  readonly url: string;
  readonly token: string;
  readonly host?: string;
}

export interface LaneHome {
  readonly home: string;
}

export type Source = Access | LaneHome;

const isLaneHome = (source: Source): source is LaneHome => "home" in source;

export function exportBrowserSource(source: Source): void {
  if (isLaneHome(source)) {
    process.env[HOME_VARIABLE] = source.home;
    return;
  }
  process.env[URL_VARIABLE] = source.url;
  process.env[TOKEN_VARIABLE] = source.token;
}

export function sourceFromEnv(env: NodeJS.ProcessEnv): Source | undefined {
  const home = env[HOME_VARIABLE];
  if (home !== undefined && home !== "") return { home };
  const url = env[URL_VARIABLE];
  const token = env[TOKEN_VARIABLE];
  return url === undefined || token === undefined || url === "" || token === ""
    ? undefined
    : { url, token };
}

const firstLabel = (name: string): string => (name.toLowerCase().split(".")[0] ?? "").trim();

function laneAt(source: LaneHome): LaneConfig {
  const lane = readLaneConfig(source.home);
  if (lane === undefined) throw new Error(`${source.home} has no config/lane.json`);
  return lane;
}

export async function resolveSource(source: Source): Promise<Access> {
  if (!isLaneHome(source)) return source;
  const lane = laneAt(source);
  const resolved = await laneToken(lane, bwsFor(lane.bws));
  if (resolved.value === undefined) throw new Error(`fleet: ${resolved.note}`);
  return { url: lane.url, token: resolved.value, host: lane.host ?? firstLabel(hostname()) };
}

export function transportsOf(source: Source): Record<string, readonly string[]> {
  if (!isLaneHome(source)) return {};
  const { hosts } = laneAt(source);
  return Object.fromEntries(
    Object.entries(hosts)
      .map(([host, argv]) => [host, strings(argv)] as const)
      .filter(([, argv]) => argv.length > 0),
  );
}

export const callUrl = (sessionUrl: string): string =>
  sessionUrl.replace(/^ws/, "http").replace(/\/session$/, "/call");

function writeAccessFile(access: Access): string {
  const file = join(tmpdir(), `fleet-browser-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(file, JSON.stringify(access), { mode: 0o600, flag: "wx" });
  return file;
}

export const viewerArguments = (source: Source): string[] =>
  isLaneHome(source) ? ["--home", source.home] : ["--access", writeAccessFile(source)];

function takeAccessFile(file: string): Access {
  const text = readFileSync(file, "utf8");
  rmSync(file, { force: true });
  return check(AccessSchema, JSON.parse(text));
}

export function sourceFromViewerArguments(flags: readonly string[]): Source {
  const at = (name: string): string | undefined => {
    const index = flags.indexOf(name);
    return index < 0 ? undefined : flags[index + 1];
  };
  const home = at("--home");
  if (home !== undefined) return { home };
  const file = at("--access");
  if (file === undefined)
    throw new Error(
      "usage: browser-view.ts --home <dir> | --access <file> [--open] [--captain] [--launch <id>]",
    );
  return takeAccessFile(file);
}
