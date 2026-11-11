import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const PROTOCOL = join("packages", "protocol", "src", "index.ts");
const SERVER = join("packages", "cardd", "src", "server.ts");
const WELCOME_SCHEMA = 't: Type.Literal("welcome"),';
const WELCOME_SEND = 'send(socket, { t: "welcome", session: session.id, role: session.role });';

function swap(root: string, file: string, from: string, to: string): void {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  if (!text.includes(from)) throw new Error(`${file} has no ${from}: update welcome-skew.ts`);
  writeFileSync(path, text.replace(from, to));
}

export function demandLowWater(root: string): void {
  swap(root, PROTOCOL, WELCOME_SCHEMA, `${WELCOME_SCHEMA}\n    lowWater: Type.Integer(),`);
  swap(
    root,
    SERVER,
    WELCOME_SEND,
    WELCOME_SEND.replace("role: session.role", "role: session.role, lowWater: 0"),
  );
}

export function dropLowWater(root: string): void {
  swap(root, PROTOCOL, `${WELCOME_SCHEMA}\n    lowWater: Type.Integer(),`, WELCOME_SCHEMA);
  swap(
    root,
    SERVER,
    WELCOME_SEND.replace("role: session.role", "role: session.role, lowWater: 0"),
    WELCOME_SEND,
  );
}

export function ownWorkspacePackages(root: string): void {
  const modules = join(root, "node_modules");
  const shared = realpathSync(modules);
  rmSync(modules);
  mkdirSync(join(modules, "@fleet"), { recursive: true });
  for (const name of readdirSync(shared).filter((each) => each !== "@fleet"))
    symlinkSync(join(shared, name), join(modules, name));
  for (const name of readdirSync(join(root, "packages")))
    symlinkSync(join("..", "..", "packages", name), join(modules, "@fleet", name));
  symlinkSync(join("..", "..", "e2e"), join(modules, "@fleet", "e2e"));
}
