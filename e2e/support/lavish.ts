import { execFileSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { spawnGuarded } from "./guarded.ts";

export class Lavish {
  readonly env: Record<string, string>;
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  private output = "";

  private constructor(dir: string) {
    this.env = {
      LAVISH_AXI_STATE_DIR: join(dir, "lavish"),
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_NO_OPEN: "1",
    };
    this.child = spawnGuarded("lavish-axi", ["server", "--port", "0"], {
      env: { ...process.env, ...this.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        this.output = (this.output + chunk.toString("utf8")).slice(-4000);
      });
    }
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => {
        resolve();
      });
    });
  }

  static async start(dir: string): Promise<Lavish> {
    const server = new Lavish(dir);
    const deadline = Date.now() + 60_000;
    try {
      for (;;) {
        const port = server.port();
        if (port !== undefined) {
          server.env["LAVISH_AXI_PORT"] = port;
          return server;
        }
        if (server.child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Lavish did not bind its own port: ${server.output}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } catch (error) {
      await server.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.child.kill("SIGTERM");
    await this.exited;
  }

  private port(): string | undefined {
    if (this.child.pid === undefined) return undefined;
    try {
      const sockets = execFileSync(
        "lsof",
        ["-a", "-p", String(this.child.pid), "-iTCP", "-sTCP:LISTEN", "-nP", "-Fn"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return /^n127\.0\.0\.1:(\d+)$/m.exec(sockets)?.[1];
    } catch {
      return undefined;
    }
  }
}
