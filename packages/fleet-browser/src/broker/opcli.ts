import { spawn } from "node:child_process";
import { BrokerError } from "./errors.js";

function mapOpError(stderr: string): BrokerError {
  const line = (stderr.split("\n").find((l) => l.includes("[ERROR]")) ?? stderr)
    .replace(/^\[ERROR\]\s+\S+\s+\S+\s+/, "")
    .trim();
  if (/429|Too Many Requests/i.test(line)) return new BrokerError("RATE_LIMITED", line.slice(0, 200));
  if (/isn't an item|isn.t a vault|not found|no item/i.test(line))
    return new BrokerError("ITEM_NOT_FOUND", line.slice(0, 200));
  if (/DecodeSACredentials|invalid.*token|authenticat|unauthori[sz]ed/i.test(line)) {
    return new BrokerError("BAD_TOKEN", "the broker's 1Password service account token was rejected");
  }
  return new BrokerError("OP_ERROR", line.slice(0, 200));
}

export class OpCli {
  private readonly opPath: string;
  private readonly token: string;
  private readonly home: string;
  private readonly onCall: ((reads: number) => void) | null;

  constructor(opPath: string, token: string, home: string, onCall: ((reads: number) => void) | null = null) {
    this.opPath = opPath;
    this.token = token;
    this.home = home;
    this.onCall = onCall;
  }

  run(args: string[], options: { stdin?: string; reads?: number } = {}): Promise<string> {
    const { stdin, reads = 1 } = options;
    return new Promise((resolve, reject) => {
      const [command, commandArgs] =
        stdin === undefined
          ? [this.opPath, args]
          : ["/bin/sh", ["-c", 'cat | "$0" "$@"', this.opPath, ...args]];
      const child = spawn(command, commandArgs, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: this.home,
          OP_SERVICE_ACCOUNT_TOKEN: this.token,
        },
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new BrokerError("OP_ERROR", `could not run the 1Password CLI: ${error.message}`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.onCall?.(reads);
        if (code === 0) resolve(stdout);
        else reject(mapOpError(stderr));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin);
    });
  }
}
