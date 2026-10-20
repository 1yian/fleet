// cardd command line.
//   cardd serve --db <file> [--listen <host:port>] [--board <built board folder>] [--hostname <name>]...   (CARDD_TIMING_SCALE=0.01 speeds up every timer, for tests)
//   cardd lane add <name> --db <file> --home <path> [--parent <lane>]   (prints the mate token)
//   cardd grant add --db <file> --lane <lane> --words <source> [--project <name>] [--may <text>] [--merge]
//   cardd project add <name> --db <file> --delivery <mode> [--clone <host>=<path>]...
import { parseArgs } from "node:util";
import { timings } from "./timing.ts";
import { openDatabase } from "./db.ts";
import { serve } from "./server.ts";
import { addLane, addLaneGrant, addProject } from "./store.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    listen: { type: "string", default: "127.0.0.1:7420" },
    board: { type: "string" },
    hostname: { type: "string", multiple: true, default: [] },
    home: { type: "string" },
    parent: { type: "string" },
    delivery: { type: "string" },
    clone: { type: "string", multiple: true, default: [] },
    lane: { type: "string" },
    project: { type: "string" },
    words: { type: "string" },
    may: { type: "string" },
    merge: { type: "boolean", default: false },
  },
});
if (values.db === undefined) throw new Error("--db is required");
const db = openDatabase(values.db);
const [command, ...rest] = positionals;

if (command === "serve") {
  const split = values.listen.lastIndexOf(":");
  const host = values.listen.slice(0, split).replace(/^\[(.*)\]$/, "$1");
  const port = values.listen.slice(split + 1);
  if (split < 0 || host === "" || !/^\d+$/.test(port))
    throw new Error(`--listen ${values.listen} must be <host>:<port>, with both parts set`);
  const scale = Number(process.env["CARDD_TIMING_SCALE"] ?? "1");
  if (!(scale > 0)) throw new Error("CARDD_TIMING_SCALE must be a positive number");
  console.log(
    `cardd listening on ${await serve(db, host, Number(port), timings(scale), values.board, values.hostname)}`,
  );
} else if (
  command === "lane" &&
  rest[0] === "add" &&
  rest[1] !== undefined &&
  values.home !== undefined
) {
  const lane = { name: rest[1], home: values.home };
  console.log(addLane(db, values.parent === undefined ? lane : { ...lane, parent: values.parent }));
} else if (
  command === "project" &&
  rest[0] === "add" &&
  rest[1] !== undefined &&
  values.delivery !== undefined
) {
  const clones: Record<string, string> = {};
  for (const pair of values.clone) {
    const split = pair.indexOf("=");
    const host = pair.slice(0, split);
    const path = pair.slice(split + 1);
    if (split < 0 || host === "" || path === "")
      throw new Error(`--clone ${pair} must be <host>=<path>, with both parts set`);
    clones[host] = path;
  }
  addProject(db, {
    name: rest[1],
    delivery: values.delivery,
    clones,
  });
} else if (
  command === "grant" &&
  rest[0] === "add" &&
  values.lane !== undefined &&
  values.words !== undefined
) {
  // An operator import, such as a Firstmate yolo flag. The words record where the permission came from.
  const grant = {
    lane: values.lane,
    words: values.words,
    may: values.may ?? "merge when CI is green",
    merge: values.merge,
  };
  addLaneGrant(db, values.project === undefined ? grant : { ...grant, project: values.project });
} else {
  throw new Error(
    "usage: cardd serve --db <file> | cardd lane add <name> --db <file> --home <path> | cardd project add <name> --db <file> --delivery <mode> [--clone <host>=<path>]...",
  );
}
