import { parseArgs } from "node:util";
import { arrangeHere } from "./arrange.ts";
import {
  codeRoot,
  existingHome,
  provision,
  restart,
  status,
  stop,
  up,
  type Outcome,
} from "./homes.ts";
import { isRecord, strings, type LaneConfig } from "./lane-config.ts";
import { costLine, costRows } from "./cost.ts";
import { setUpMemory } from "./memory.ts";
import { migrate, undoMigration } from "./migrate.ts";
import { convergeSharedPreferences } from "./standing.ts";
import { hostProblems } from "./prerequisites.ts";
import { mateTitle } from "./titles.ts";
import { checkCardd, checkHost, updateCardd, updateHost } from "./update.ts";
import { wakeMate } from "./wake.ts";

const USAGE =
  "usage: fleet status | up [lane] | stop <lane> | arrange | restart [lane] | shared --content BASE64|--absent | update [--check] | cardd --root R --db D [--check] [--running SHA] [--restart JSON] | home add <lane> --url U --token T | home memory <lane> | wake <lane> <note> [--script NAME] | cost [--json] | migrate [--undo]";

const VALUE_OPTIONS = new Set([
  "--from",
  "--url",
  "--token",
  "--args",
  "--worker-args",
  "--host",
  "--hosts",
  "--roots",
  "--direnv",
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

const { values, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    undo: { type: "boolean" },
    check: { type: "boolean" },
    from: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    args: { type: "string" },
    "worker-args": { type: "string" },
    host: { type: "string" },
    hosts: { type: "string" },
    roots: { type: "string" },
    direnv: { type: "string" },
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
const [command, ...rest] = positionals;
const root = codeRoot();

const json = (text: string | undefined): unknown =>
  text === undefined ? undefined : JSON.parse(text);

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
  const problems = hostProblems(root);
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
    if (
      rest[0] !== "add" ||
      rest[1] === undefined ||
      values.url === undefined ||
      values.token === undefined
    )
      throw new Error(USAGE);
    const hosts = json(values.hosts);
    const roots = json(values.roots);
    const config: LaneConfig = {
      lane: rest[1],
      url: values.url,
      token: values.token,
      ...(values.host === undefined ? {} : { host: values.host }),
      hosts: isRecord(hosts) ? hosts : {},
      roots: isRecord(roots)
        ? Object.fromEntries(Object.entries(roots).map(([k, v]) => [k, String(v)]))
        : {},
      args: strings(json(values.args)),
      workerArgs: strings(json(values["worker-args"])),
      ...(values.direnv === undefined ? {} : { direnv: values.direnv }),
    };
    console.log(provision(root, config));
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
  case "cost": {
    const rows = costRows(root, Date.now());
    if (values.json === true) console.log(JSON.stringify(rows));
    else for (const row of rows) console.log(costLine(row));
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
