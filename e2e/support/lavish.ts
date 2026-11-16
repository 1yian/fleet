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

  open(file: string): { session: string; url: string } {
    const opened = execFileSync("lavish-axi", [file, "--no-open"], {
      env: { ...process.env, ...this.env },
      encoding: "utf8",
    });
    const url = /(https?:\/\/\S+\/session\/(\w+))/.exec(opened);
    if (url?.[1] === undefined || url[2] === undefined)
      throw new Error(`lavish-axi gave no session for ${file}: ${opened}`);
    return { session: url[2], url: url[1] };
  }

  async say(session: string, text: string): Promise<void> {
    const origin = `http://127.0.0.1:${this.env["LAVISH_AXI_PORT"] ?? ""}`;
    const response = await fetch(`${origin}/api/${session}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ prompts: [{ tag: "message", prompt: text }] }),
    });
    if (response.status !== 200)
      throw new Error(`the page refused the feedback: ${await response.text()}`);
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
