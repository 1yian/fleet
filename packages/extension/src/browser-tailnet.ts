import { execFile } from "node:child_process";
import { isIPv4 } from "node:net";
import Type, { type Static } from "typebox";
import { check } from "@fleet/protocol";

const StatusSchema = Type.Object({
  BackendState: Type.String(),
  Self: Type.Object({ DNSName: Type.String(), TailscaleIPs: Type.Array(Type.String()) }),
});

const CLIENTS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const ASK_MS = 5_000;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;

export type Reach =
  | { readonly found: true; readonly address: string; readonly name: string | undefined }
  | { readonly found: false; readonly why: string };

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  error.cause instanceof Error &&
  "code" in error.cause &&
  error.cause.code === "ENOENT";

function ask(client: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      client,
      ["status", "--json"],
      { timeout: ASK_MS, maxBuffer: MAX_STATUS_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(firstLine(stderr) || firstLine(error.message), { cause: error }));
      },
    );
  });
}

async function statusOf(env: NodeJS.ProcessEnv): Promise<string> {
  const named = env["FLEET_TAILSCALE"];
  for (const client of named === undefined || named === "" ? CLIENTS : [named]) {
    try {
      return await ask(client);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  throw new Error("the tailscale command was not found");
}

function parsed(text: string): Static<typeof StatusSchema> {
  try {
    return check(StatusSchema, JSON.parse(text));
  } catch {
    throw new Error("tailscale gave a status that is not what was expected");
  }
}

export async function tailnetOf(env: NodeJS.ProcessEnv): Promise<Reach> {
  let status: Static<typeof StatusSchema>;
  try {
    status = parsed(await statusOf(env));
  } catch (error) {
    return { found: false, why: error instanceof Error ? error.message : "tailscale failed" };
  }
  const { BackendState, Self } = status;
  if (BackendState !== "Running") return { found: false, why: `tailscale is ${BackendState}` };
  const address = Self.TailscaleIPs.find((each) => isIPv4(each) && each !== "0.0.0.0");
  if (address === undefined)
    return { found: false, why: "tailscale gave this machine no IPv4 address" };
  const name = Self.DNSName.replace(/\.$/, "").toLowerCase();
  return { found: true, address, name: name === "" ? undefined : name };
}
