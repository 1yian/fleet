// cardd command line.
//   cardd serve --db <file> [--listen <host:port>] [--board <built board folder>]   (CARDD_TIMING_SCALE=0.01 speeds up every timer, for tests)
//   cardd lane add <name> --db <file> --home <path> [--parent <lane>]   (prints the mate token)
//   cardd project add <name> --db <file> --delivery <mode> [--capacity <n>] [--clone <host>=<path>]...
import { parseArgs } from "node:util";
import { timings } from "./timing.ts";
import { openDatabase } from "./db.ts";
import { serve } from "./server.ts";
import { addLane, addProject } from "./store.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    listen: { type: "string", default: "127.0.0.1:7420" },
    board: { type: "string" },
    home: { type: "string" },
    parent: { type: "string" },
    delivery: { type: "string" },
    capacity: { type: "string", default: "2" },
    clone: { type: "string", multiple: true, default: [] },
  },
});
if (values.db === undefined) throw new Error("--db is required");
const db = openDatabase(values.db);
const [command, ...rest] = positionals;

if (command === "serve") {
  const [host = "", port = ""] = values.listen.split(":");
  // The board has no login: only the Tailscale network may reach cardd (spec section 21.4).
  if (host === "0.0.0.0" || host === "::")
    throw new Error("cardd binds to the Tailscale address, never to every interface");
  const scale = Number(process.env["CARDD_TIMING_SCALE"] ?? "1");
  if (!(scale > 0)) throw new Error("CARDD_TIMING_SCALE must be a positive number");
  console.log(
    `cardd listening on ${await serve(db, host, Number(port), timings(scale), values.board)}`,
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
    capacity: Number(values.capacity),
    clones,
  });
} else {
  throw new Error(
    "usage: cardd serve --db <file> | cardd lane add <name> --db <file> --home <path> | cardd project add <name> --db <file> --delivery <mode> [--capacity <n>] [--clone <host>=<path>]...",
  );
}
