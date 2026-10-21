import { parseArgs } from "node:util";
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
import { lavishProblem } from "./lavish.ts";
import { setUpMemory } from "./memory.ts";
import { migrate, undoMigration } from "./migrate.ts";
import { mateTitle } from "./titles.ts";

const USAGE =
  "usage: fleet status | up [lane] | stop <lane> | restart [lane] | home add <lane> --url U --token T | home memory <lane> | migrate [--undo]";

const VALUE_OPTIONS = new Set([
  "--from",
  "--url",
  "--token",
  "--args",
  "--worker-args",
  "--hosts",
  "--roots",
  "--direnv",
  "--seed",
  "--source",
  "--compactor",
  "--thinking",
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
    from: { type: "string" },
    url: { type: "string" },
    token: { type: "string" },
    args: { type: "string" },
    "worker-args": { type: "string" },
    hosts: { type: "string" },
    roots: { type: "string" },
    direnv: { type: "string" },
    seed: { type: "string" },
    source: { type: "string" },
    compactor: { type: "string" },
    thinking: { type: "string" },
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
  const problem = lavishProblem();
  if (problem !== undefined) {
    console.error(problem);
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
  case "stop":
    await stop(root, lane());
    console.log(`${lane()}: stopped`);
    break;
  case "restart":
    show(await restart(root, rest[0]));
    break;
  case "home": {
    if (rest[0] === "memory" && rest[1] !== undefined) {
      const { seed, source, compactor, thinking } = values;
      const options = {
        ...(seed === undefined ? {} : { seed }),
        ...(source === undefined ? {} : { source }),
        ...(compactor === undefined ? {} : { compactor }),
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
  case "migrate":
    for (const line of values.undo === true
      ? undoMigration(root, values.from)
      : migrate(root, values.from))
      console.log(line);
    break;
  default:
    throw new Error(USAGE);
}
