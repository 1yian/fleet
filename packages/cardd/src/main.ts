import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { timings } from "./timing.ts";
import { openDatabase } from "./db.ts";
import { fillRepo, projectsWithoutRepo, type Hosts } from "./pulls.ts";
import { stampLogLines } from "./log.ts";
import { serve } from "./server.ts";
import { DELIVERIES } from "@fleet/protocol";
import { setCardDelivery } from "./attempts.ts";
import { parsePlan, setNextPlan, showPlans } from "./plans.ts";
import { addLane, addProject, setClone, setProjectDelivery, setRepo, setYolo } from "./store.ts";

if (process.argv[2] === "serve") {
  stampLogLines();
  process.on("uncaughtException", (error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    listen: { type: "string", default: "127.0.0.1:7420" },
    board: { type: "string" },
    hostname: { type: "string", multiple: true, default: [] },
    home: { type: "string" },
    parent: { type: "string" },
    plan: { type: "string" },
    delivery: { type: "string" },
    clone: { type: "string", multiple: true, default: [] },
    yolo: { type: "boolean", default: false },
    repo: { type: "string" },
    hosts: { type: "string", default: "{}" },
  },
});
if (values.db === undefined) throw new Error("--db is required");
const db = openDatabase(values.db);
const [command, ...rest] = positionals;
const hosts = parseHosts(values.hosts);

function parseHosts(raw: string): Hosts {
  const parsed: unknown = JSON.parse(raw);
  const usage = `--hosts ${raw} must be a JSON object of host names to argv arrays, such as {"p620":["ssh","p620"]}`;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(usage);
  const entries = Object.entries(parsed).map(([host, argv]: [string, unknown]) => {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((part) => typeof part === "string")
    )
      throw new Error(usage);
    return [host, argv.map(String)] as const;
  });
  return Object.fromEntries(entries);
}

function ownerName(repo: string, flag: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`${flag} ${repo} must be <owner>/<name>`);
  return repo;
}

function deliveryMode(raw: string, flag: string): (typeof DELIVERIES)[number] {
  const mode = DELIVERIES.find((each) => each === raw);
  if (mode === undefined) throw new Error(`${flag} ${raw} must be one of ${DELIVERIES.join(", ")}`);
  return mode;
}

function clockFrom(file: string | undefined): () => number {
  if (file === undefined) return Date.now;
  return () => {
    const text = readFileSync(file, "utf8").trim();
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) throw new Error(`CARDD_CLOCK_FILE ${file} holds ${text}, not a time`);
    return ms;
  };
}

function parseClone(pair: string): [string, string] {
  const split = pair.indexOf("=");
  const host = pair.slice(0, split);
  const path = pair.slice(split + 1);
  if (split < 0 || host === "" || path === "")
    throw new Error(`--clone ${pair} must be <host>=<path>, with both parts set`);
  return [host, path];
}

if (command === "serve") {
  const split = values.listen.lastIndexOf(":");
  const host = values.listen.slice(0, split).replace(/^\[(.*)\]$/, "$1");
  const port = values.listen.slice(split + 1);
  if (split < 0 || host === "" || !/^\d+$/.test(port))
    throw new Error(`--listen ${values.listen} must be <host>:<port>, with both parts set`);
  const scale = Number(process.env["CARDD_TIMING_SCALE"] ?? "1");
  if (!(scale > 0)) throw new Error("CARDD_TIMING_SCALE must be a positive number");
  const clock = clockFrom(process.env["CARDD_CLOCK_FILE"]);
  const url = await serve(db, host, Number(port), timings(scale, clock), {
    files: values.board,
    hostnames: values.hostname,
    hosts,
  });
  console.log(`cardd listening on ${url}`);
} else if (
  command === "lane" &&
  rest[0] === "add" &&
  rest[1] !== undefined &&
  values.home !== undefined
) {
  const lane = { name: rest[1], home: values.home };
  console.log(addLane(db, values.parent === undefined ? lane : { ...lane, parent: values.parent }));
} else if (command === "lane" && rest[0] === "plan" && rest[1] !== undefined) {
  if (values.plan !== undefined) setNextPlan(db, rest[1], parsePlan(values.plan));
  console.log(JSON.stringify(showPlans(db, rest[1])));
} else if (
  command === "project" &&
  rest[0] === "add" &&
  rest[1] !== undefined &&
  values.delivery !== undefined
) {
  const clones: Record<string, string> = {};
  for (const pair of values.clone) {
    const [host, path] = parseClone(pair);
    clones[host] = path;
  }
  const repo = values.repo === undefined ? null : ownerName(values.repo, "--repo");
  addProject(db, { name: rest[1], delivery: values.delivery, clones, yolo: values.yolo, repo });
  await Promise.all(projectsWithoutRepo(db).map((project) => fillRepo(db, hosts, project)));
} else if (
  command === "project" &&
  rest[0] === "repo" &&
  rest[1] !== undefined &&
  rest[2] !== undefined
) {
  setRepo(db, rest[1], ownerName(rest[2], "project repo"));
  console.log(`${rest[1]}: repo ${rest[2]}`);
} else if (
  command === "project" &&
  rest[0] === "clone" &&
  rest[1] !== undefined &&
  rest[2] !== undefined
) {
  const [host, path] = parseClone(rest[2]);
  setClone(db, rest[1], host, path);
  console.log(`${rest[1]}: clone on ${host} is ${path}`);
} else if (
  command === "project" &&
  rest[0] === "delivery" &&
  rest[1] !== undefined &&
  rest[2] !== undefined
) {
  setProjectDelivery(db, rest[1], deliveryMode(rest[2], "project delivery"));
  console.log(`${rest[1]}: delivery ${rest[2]}`);
} else if (
  command === "card" &&
  rest[0] === "delivery" &&
  rest[1] !== undefined &&
  rest[2] !== undefined
) {
  if (!/^[1-9][0-9]*$/.test(rest[1])) throw new Error(`card ${rest[1]} must be a card number`);
  console.log(setCardDelivery(db, Number(rest[1]), deliveryMode(rest[2], "card delivery")));
} else if (
  command === "project" &&
  rest[0] === "yolo" &&
  rest[1] !== undefined &&
  (rest[2] === "on" || rest[2] === "off")
) {
  setYolo(db, rest[1], rest[2] === "on");
  console.log(`${rest[1]}: yolo ${rest[2]}`);
} else {
  throw new Error(
    "usage: cardd serve --db <file> [--hosts <json>] | cardd lane add <name> --db <file> --home <path> | cardd lane plan <name> --db <file> [--plan <json>] | cardd project add <name> --db <file> --delivery <mode> [--clone <host>=<path>]... [--yolo] [--repo <owner/name>] [--hosts <json>] | cardd project clone <name> <host>=<path> --db <file> | cardd project repo <name> <owner/name> --db <file> | cardd project yolo <name> on|off --db <file> | cardd project delivery <name> <mode> --db <file> | cardd card delivery <number> <mode> --db <file>",
  );
}
