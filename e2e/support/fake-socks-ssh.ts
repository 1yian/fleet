import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";

const [dir = "", ...argv] = process.argv.slice(2);

let forward: string | undefined;
let rest = argv;
while (rest[0]?.startsWith("-") === true) {
  if (rest[0] === "-D") forward = rest[1];
  rest = rest[0] === "-N" ? rest.slice(1) : rest.slice(2);
}
const [host = "", ...command] = rest;

const note = (record: Record<string, unknown>): void => {
  appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ host, ...record })}\n`);
};

const HOST_SUFFIX = ".example.test";

function refuse(client: Socket): void {
  client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function destination(request: Buffer): { name: string; port: number } | undefined {
  if (request[1] !== 1) return undefined;
  if (request[3] === 3) {
    const length = request[4] ?? 0;
    return {
      name: request.subarray(5, 5 + length).toString("utf8"),
      port: request.readUInt16BE(5 + length),
    };
  }
  if (request[3] === 1)
    return { name: [...request.subarray(4, 8)].join("."), port: request.readUInt16BE(8) };
  return undefined;
}

function bridge(client: Socket, request: Buffer): void {
  const wanted = destination(request);
  if (wanted === undefined) {
    refuse(client);
    return;
  }
  note({ kind: "socks", destination: `${wanted.name}:${String(wanted.port)}` });
  const target = wanted.name.endsWith(HOST_SUFFIX) ? "127.0.0.1" : wanted.name;
  const upstream = connect({ host: target, port: wanted.port }, () => {
    client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  upstream.on("error", () => {
    refuse(client);
    upstream.destroy();
  });
  client.on("close", () => {
    upstream.destroy();
  });
}

function serve(address: string): void {
  const at = address.lastIndexOf(":");
  const server = createServer((client) => {
    client.on("error", () => {
      client.destroy();
    });
    client.once("data", () => {
      client.write(Buffer.from([5, 0]));
      client.once("data", (request) => {
        bridge(client, request);
      });
    });
  });
  server.listen(Number(address.slice(at + 1)), address.slice(0, at));
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
}

if (forward !== undefined) {
  note({ kind: "forward", address: forward });
  serve(forward);
} else {
  note({ kind: "command", command: command.join(" ") });
  const child = spawn("sh", ["-c", command.join(" ")], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 143));
  });
}
