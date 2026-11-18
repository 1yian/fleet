import { registerGroup } from "./marked.ts";

const [herdr, ...args] = process.argv.slice(2);
if (herdr === undefined || process.execve === undefined) throw new Error("cannot launch lab Herdr");
registerGroup(process.pid);
process.execve(herdr, [herdr, ...args]);
