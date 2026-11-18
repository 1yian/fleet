import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { guardCleanup } from "./guarded.ts";
import { spawnOwned } from "./marked.ts";
import { tempDir } from "./run-root.ts";

const port = Number(process.env["DIRECT_FIXTURE_PORT"]);
const mark = process.env["DIRECT_FIXTURE_MARK"] ?? "";
const xdg = process.env["XDG_CONFIG_HOME"] ?? "";
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const root = dirname(tempDir("direct-"));
mkdirSync(xdg, { recursive: true });
guardCleanup("root-intact", ["sh", "-c", `test -d ${quote(xdg)} && echo alive > ${quote(mark)}`]);
const announce = `const socket = require('node:net').connect(${String(port)}, '127.0.0.1');
  socket.on('connect', () => socket.write(process.pid + '\\n' + ${JSON.stringify(JSON.stringify(root))} + '\\n'));
  setInterval(() => undefined, 1e6);`;
spawnOwned(process.execPath, ["-e", announce], { stdio: "ignore" }).unref();
setInterval(() => undefined, 1 << 30);
