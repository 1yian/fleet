// An isolated herdr lab session for dispatch tests. The name always starts with
// fleet-lab-, so a test can never touch the captain's default session.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, parseRecord, records, type JsonRecord } from "./json.ts";

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

  /** The text on a pane's screen right now. */
  async screen(pane: string): Promise<string> {
    return this.text(["pane", "read", pane, "--source", "visible"]);
  }

  /** Types into a pane, then presses Enter. */
  async submit(pane: string, text: string): Promise<void> {
    await this.text(["pane", "send-text", pane, text]);
    await this.text(["pane", "send-keys", pane, "enter"]);
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

  /** After a failed test, prints what the lab shows. Call it before anything stops, since stop deletes the log. */
  async printIfFailed(context: object): Promise<void> {
    if (!("passed" in context) || context.passed !== false) return;
    process.stderr.write(await this.report().catch((error: unknown) => `${String(error)}\n`));
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

  /** Each pane's workspace, foreground processes, and recent screen, then the end of herdr's log. */
  private async report(): Promise<string> {
    const lines = [`--- herdr lab ${this.name} at ${new Date().toISOString()}`];
    const workspaces = records((await this.run(["workspace", "list"]))["workspaces"]);
    const labels = new Map(workspaces.map((each) => [each["workspace_id"], each["label"]]));
    for (const pane of records((await this.run(["pane", "list"]))["panes"])) {
      const id = String(pane["pane_id"]);
      const info = await this.run(["pane", "process-info", "--pane", id]);
      const processes = records(records([info["process_info"]])[0]?.["foreground_processes"]);
      const running = processes.map((each) => `${String(each["pid"])}:${String(each["name"])}`);
      const label = String(labels.get(pane["workspace_id"]));
      lines.push(`--- pane ${id} in ${label}, cwd ${String(pane["cwd"])}`);
      lines.push(`foreground: ${running.join(" ")}`);
      lines.push(await this.text(["pane", "read", id, "--source", "recent", "--lines", "60"]));
    }
    const sessions = (await this.text(["session", "list"])).split("\n");
    const directory = sessions
      .map((line) => line.trim().split(/\s+/))
      .find((cells) => cells[0] === this.name)?.[2];
    if (directory !== undefined) {
      const log = readFileSync(join(directory, "herdr-server.log"), "utf8").split("\n");
      lines.push(`--- herdr-server.log, last 200 lines`, ...log.slice(-200));
    }
    return `${lines.join("\n")}\n--- end of herdr lab ${this.name}\n`;
  }

  private async running(): Promise<boolean> {
    const status: JsonRecord = await this.raw(["status", "--json"]).catch(() => ({}));
    const server: unknown = status["server"];
    return isRecord(server) && server["running"] === true;
  }
}
