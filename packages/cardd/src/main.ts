// cardd command line.
//   cardd serve --db <file> [--listen <host:port>]
//   cardd lane add <name> --db <file> --home <path> [--parent <lane>]   (prints the mate token)
//   cardd project add <name> --db <file> --delivery <mode> [--capacity <n>]
import { parseArgs } from "node:util";
import { openDatabase } from "./db.ts";
import { serve } from "./server.ts";
import { addLane, addProject } from "./store.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: "string" },
    listen: { type: "string", default: "127.0.0.1:7420" },
    home: { type: "string" },
    parent: { type: "string" },
    delivery: { type: "string" },
    capacity: { type: "string", default: "2" },
  },
});
if (values.db === undefined) throw new Error("--db is required");
const db = openDatabase(values.db);
const [command, ...rest] = positionals;

if (command === "serve") {
  const [host = "", port = ""] = values.listen.split(":");
  console.log(`cardd listening on ${await serve(db, host, Number(port))}`);
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
  addProject(db, { name: rest[1], delivery: values.delivery, capacity: Number(values.capacity) });
} else {
  throw new Error(
    "usage: cardd serve --db <file> | cardd lane add <name> --db <file> --home <path> | cardd project add <name> --db <file> --delivery <mode> [--capacity <n>]",
  );
}
