// An isolated herdr lab session for dispatch tests. The name always starts with
// fleet-lab-, so a test can never touch the captain's default session.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isRecord, parseRecord, type JsonRecord } from "./json.ts";

const WAIT_MS = 30_000;

export class HerdrLab {
  readonly name = `fleet-lab-${randomBytes(3).toString("hex")}`;
  private server: ChildProcess | undefined;

  /** Starts the lab server. Panes inherit `env`, so workers there can reach the test. */
  static async start(env: Record<string, string>): Promise<HerdrLab> {
    const lab = new HerdrLab();
    lab.server = spawn("herdr", ["server", "--session", lab.name], {
      env: { ...process.env, ...env, HERDR_SESSION: lab.name },
      stdio: "ignore",
    });
    const deadline = Date.now() + WAIT_MS;
    while (!(await lab.running())) {
      if (Date.now() > deadline) throw new Error(`herdr lab ${lab.name} did not start`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return lab;
  }

  /** Runs a herdr command in the lab and returns its `result`. */
  async run(args: readonly string[]): Promise<JsonRecord> {
    const reply = await this.raw(args);
    return isRecord(reply["result"]) ? reply["result"] : {};
  }

  private async raw(args: readonly string[]): Promise<JsonRecord> {
    return parseRecord(await this.text(args));
  }

  private async text(args: readonly string[]): Promise<string> {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        "herdr",
        [...args, "--session", this.name],
        { encoding: "utf8", env: { ...process.env, HERDR_SESSION: this.name } },
        (error, stdout) => {
          if (error !== null && stdout === "") reject(new Error(error.message));
          else resolve(stdout);
        },
      );
    });
    return out;
  }

  /** Stops the lab server and its panes, then deletes the session. These commands print text, not JSON. */
  async stop(): Promise<void> {
    await this.text(["session", "stop", this.name]).catch(() => "");
    const server = this.server;
    if (server?.exitCode === null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGKILL");
      await exited;
    }
    await this.text(["session", "delete", this.name]);
  }

  private async running(): Promise<boolean> {
    const status: JsonRecord = await this.raw(["status", "--json"]).catch(() => ({}));
    const server: unknown = status["server"];
    return isRecord(server) && server["running"] === true;
  }
}
