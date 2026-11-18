import { registerGroup } from "./marked.ts";

const [command, ...args] = process.argv.slice(2);
if (command === undefined || process.execve === undefined) throw new Error("cannot launch detached fixture");
if (registerGroup(process.pid) === undefined) throw new Error("could not verify detached fixture group");
process.execve("/bin/sh", ["sh", "-c", 'exec "$@"', "fixture", command, ...args]);
