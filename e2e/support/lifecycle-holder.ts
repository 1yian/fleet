import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

const HOLDER = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("held\\n");
process.stdin.on("end", () => {
  db.exec("ROLLBACK");
  process.exit(0);
});
process.stdin.resume();
`;

export class LifecycleHolder {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;

  private constructor(child: ChildProcessByStdio<Writable, Readable, null>) {
    this.child = child;
  }

  static async hold(home: string): Promise<LifecycleHolder> {
    const child = spawn(process.execPath, ["-e", HOLDER, join(home, "state", "lifecycle.db")], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        reject(new Error("lifecycle holder exited before holding"));
      });
      child.stdout.once("data", () => {
        resolve();
      });
    });
    return new LifecycleHolder(child);
  }

  async release(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.stdin.end();
    await exited;
  }

  async crash(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.kill("SIGKILL");
    await exited;
  }
}
