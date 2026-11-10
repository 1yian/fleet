import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { arrangeHere } from "./arrange.ts";
import {
  codeRoot,
  existingHome,
  homeOf,
  laneHomes,
  provision,
  reconfigure,
  restart,
  status,
  stop,
  up,
  type Outcome,
} from "./homes.ts";
import { isRecord, parseLaneConfig, readLaneConfig, strings } from "./lane-config.ts";
import { checkLaneSecrets } from "./lane-secrets.ts";
import { costRows } from "./cost.ts";
import { setUpMemory } from "./memory.ts";
import { migrate, undoMigration } from "./migrate.ts";
import { convergeSharedPreferences } from "./standing.ts";
import { hostProblems } from "./prerequisites.ts";
import { mateTitle } from "./titles.ts";
import { checkCardd, checkHost, updateCardd, updateHost } from "./update.ts";
import { wakeMate } from "./wake.ts";

const USAGE = [
  "usage: fleet status | up [lane] [--maintenance] | stop <lane> | arrange | restart [lane] | shared --content BASE64|--absent | update [--check] | cardd --root R --db D [--check] [--running SHA] [--restart JSON] | home add <lane> --url U (--token-file FILE|- | --token T | --bws JSON) [--hold] [lane options] | home set <lane> [lane options] | home memory <lane> [--seed DIR] [--thinking LEVEL] | wake <lane> <note> [--script NAME] | secrets [lane] | cost | migrate [--undo]",
  "lane options (home add, home set): --host NAME --hosts JSON --roots JSON --tier MODEL --args JSON --worker-args JSON --direnv FOLDER",
  "  --hosts and --roots take a JSON object, --args and --worker-args a JSON array of strings, and home set also takes --url. An empty --host, --tier, or --direnv clears it.",
  "  --token-file reads the lane token from a file, or from standard input with -, so it never sits in a command line. --hold makes the home held until it is started.",
].join("\n");

const VALUE_OPTIONS = new Set([
  "--from",
  "--url",
  "--token",
  "--token-file",
  "--bws",
  "--args",
  "--worker-args",
  "--host",
  "--hosts",
  "--roots",
  "--direnv",
  "--tier",
  "--seed",
  "--thinking",
  "--root",
  "--db",
  "--running",
  "--restart",
  "--content",
  "--script",
]);
const argv = process.argv.slice(2).reduce<string[]>((out, arg, index, all) => {
  if (VALUE_OPTIONS.has(all[index - 1] ?? "")) return out;
  const value = all[index + 1];
  out.push(VALUE_OPTIONS.has(arg) && value !== undefined ? `${arg}=${value}` : arg);
  return out;
}, []);

if (argv.some((arg) => arg === "--help" || arg === "-h")) {
  console.log(USAGE);
  process.exit(0);
}

function parse(): ReturnType<typeof parseCommandLine> {
  try {
    return parseCommandLine();
  } catch (error) {
    console.error(`fleet: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
  }
}

function parseCommandLine() {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      undo: { type: "boolean" },
      check: { type: "boolean" },
      maintenance: { type: "boolean" },
      from: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      "token-file": { type: "string" },
      hold: { type: "boolean" },
      bws: { type: "string" },
      args: { type: "string" },
      "worker-args": { type: "string" },
      host: { type: "string" },
      hosts: { type: "string" },
      roots: { type: "string" },
      direnv: { type: "string" },
      tier: { type: "string" },
      seed: { type: "string" },
      thinking: { type: "string" },
      root: { type: "string" },
      db: { type: "string" },
      running: { type: "string" },
      restart: { type: "string" },
      content: { type: "string" },
      absent: { type: "boolean" },
      script: { type: "string" },
    },
  });
}

const { values, positionals } = parse();
const [command, ...rest] = positionals;
const root = codeRoot();

const json = (text: string | undefined): unknown =>
  text === undefined ? undefined : JSON.parse(text);

function parsed(flag: string, text: string, shape: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${flag} must be ${shape}`);
  }
}

function jsonObject(flag: string, text: string): Record<string, unknown> {
  const value = parsed(flag, text, "a JSON object");
  if (!isRecord(value)) throw new Error(`${flag} must be a JSON object`);
  return value;
}

function jsonRoots(text: string): Record<string, string> {
  const entries = Object.entries(jsonObject("--roots", text));
  const roots: Record<string, string> = {};
  for (const [host, path] of entries) {
    if (typeof path !== "string")
      throw new Error("--roots must be a JSON object of host names to folders");
    roots[host] = path;
  }
  return roots;
}

function jsonStrings(flag: string, text: string): string[] {
  const value = parsed(flag, text, "a JSON array of strings");
  if (!Array.isArray(value) || !value.every((each) => typeof each === "string"))
    throw new Error(`${flag} must be a JSON array of strings`);
  return value.map(String);
}

const clearable = (text: string): string | undefined => (text === "" ? undefined : text);

function laneSettings(): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  const given = (key: string, text: string | undefined, read: (text: string) => unknown): void => {
    if (text !== undefined) settings[key] = read(text);
  };
  given("url", values.url, (text) => text);
  given("host", values.host, clearable);
  given("tier", values.tier, clearable);
  given("direnv", values.direnv, clearable);
  given("hosts", values.hosts, (text) => jsonObject("--hosts", text));
  given("roots", values.roots, jsonRoots);
  given("args", values.args, (text) => jsonStrings("--args", text));
  given("workerArgs", values["worker-args"], (text) => jsonStrings("--worker-args", text));
  return settings;
}

function leaseToken(): string | undefined {
  const { token, "token-file": file } = values;
  if (token !== undefined && file !== undefined)
    throw new Error("give --token or --token-file, not both");
  if (file === undefined) {
    if (token !== undefined)
      console.error(
        "fleet: --token puts the token in the process list and in shell history. Pipe it in with --token-file - instead",
      );
    return token;
  }
  const text = readFileSync(file === "-" ? 0 : file, "utf8").trim();
  if (text === "") throw new Error(`${file === "-" ? "standard input" : file} holds no token`);
  return text;
}

function show(outcomes: readonly Outcome[]): void {
  if (values.json === true) console.log(JSON.stringify(outcomes));
  for (const { lane, action, detail } of values.json === true ? [] : outcomes) {
    const text = {
      started: `started in ${mateTitle(lane)}`,
      running: `already running in ${mateTitle(lane)}`,
      held: `held: ${detail ?? ""}`,
      stopped: `stopped: ${detail ?? ""}`,
    }[action];
    console.log(`${lane}: ${text}`);
  }
}

function lane(): string {
  const [name] = rest;
  if (name === undefined) throw new Error(USAGE);
  return name;
}

if (command === "up" || command === "restart") {
  const problems = hostProblems(root, values.maintenance !== true);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}

switch (command ?? "") {
  case "status": {
    const lanes = await status(root);
    if (values.json === true) console.log(JSON.stringify(lanes));
    else
      for (const each of lanes)
        console.log(
          `${each.lane}: ${each.state}${each.reason === undefined ? "" : ` (${each.reason})`}`,
        );
    break;
  }
  case "up":
    show(await up(root, rest[0]));
    break;
  case "shared": {
    if (values.absent !== true && values.content === undefined) throw new Error(USAGE);
    const bytes =
      values.absent === true
        ? undefined
        : Buffer.from(values.content ?? "", "base64").toString("utf8");
    for (const { lane: name, result } of convergeSharedPreferences(root, bytes))
      console.log(`${name}: shared preferences ${result}`);
    break;
  }
  case "arrange":
    await arrangeHere().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    break;
  case "stop":
    await stop(root, lane());
    console.log(`${lane()}: stopped`);
    break;
  case "restart":
    show(await restart(root, rest[0]));
    break;
  case "home": {
    if (rest[0] === "memory" && rest[1] !== undefined) {
      const { seed, thinking } = values;
      const options = {
        ...(seed === undefined ? {} : { seed }),
        ...(thinking === undefined ? {} : { thinking }),
      };
      for (const line of setUpMemory(existingHome(root, rest[1]), rest[1], options))
        console.log(`${rest[1]}: ${line}`);
      break;
    }
    if (rest[0] === "set" && rest[1] !== undefined) {
      if (
        values.token !== undefined ||
        values["token-file"] !== undefined ||
        values.bws !== undefined
      )
        throw new Error("home set does not change a lane's credentials");
      const changes = laneSettings();
      if (Object.keys(changes).length === 0) throw new Error(USAGE);
      reconfigure(existingHome(root, rest[1]), changes);
      console.log(
        `${rest[1]}: set ${Object.keys(changes).join(", ")}. Restart the lane for its mate to use them`,
      );
      break;
    }
    if (rest[0] !== "add" || rest[1] === undefined) throw new Error(USAGE);
    if (readLaneConfig(homeOf(root, rest[1])) !== undefined) {
      console.log(homeOf(root, rest[1]));
      console.error(
        `${rest[1]}: the home is made already, and config/lane.json is kept. fleet home set changes it`,
      );
      break;
    }
    const token = leaseToken();
    if (values.url === undefined || (token === undefined && values.bws === undefined))
      throw new Error(USAGE);
    const config = parseLaneConfig("fleet home add", {
      hosts: {},
      roots: {},
      args: [],
      workerArgs: [],
      ...laneSettings(),
      lane: rest[1],
      ...(token === undefined ? {} : { token }),
      ...(values.bws === undefined ? {} : { bws: json(values.bws) }),
    });
    console.log(provision(root, config, values.hold === true));
    break;
  }
  case "update": {
    const result =
      values.check === true ? (checkHost(root) ?? { state: "ready", root }) : updateHost(root);
    console.log(JSON.stringify(result));
    break;
  }
  case "cardd": {
    const { root: carddRoot, db, running, restart: command } = values;
    if (carddRoot === undefined || db === undefined) throw new Error(USAGE);
    const result =
      values.check === true
        ? (checkCardd(carddRoot, db) ?? { state: "ready", root: carddRoot })
        : updateCardd(carddRoot, db, running, strings(json(command)));
    console.log(JSON.stringify(result));
    break;
  }
  case "wake": {
    const [name, note] = rest;
    if (name === undefined || note === undefined) throw new Error(USAGE);
    const args = values.script === undefined ? { note } : { note, script: values.script };
    await wakeMate(existingHome(root, name), args).then(
      () => {
        console.log(`${name}: woken`);
      },
      (error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
    break;
  }
  case "secrets": {
    const main = readLaneConfig(root);
    const here = [
      ...(main === undefined ? [] : [main]),
      ...laneHomes(root).map((each) => each.config),
    ];
    const named = here.filter((each) => rest[0] === undefined || each.lane === rest[0]);
    if (named.length === 0) throw new Error(`no lane ${rest[0] ?? ""} on this host`);
    let failed = false;
    for (const each of named) {
      const checked = await checkLaneSecrets(each);
      for (const line of checked.lines) console.log(line);
      failed ||= checked.failed;
    }
    if (failed) process.exit(1);
    break;
  }
  case "cost": {
    console.log(JSON.stringify(costRows(root, Date.now())));
    break;
  }
  case "migrate":
    for (const line of values.undo === true
      ? undoMigration(root, values.from)
      : migrate(root, values.from))
      console.log(line);
    break;
  default:
    throw new Error(USAGE);
}
