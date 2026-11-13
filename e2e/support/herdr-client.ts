import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tempDir } from "./run-root.ts";
import { spawnGuarded } from "./guarded.ts";
import type { HerdrLab } from "./herdr.ts";
import { records, type JsonRecord } from "./json.ts";

const WAIT_MS = 30_000;
const CTRL = 16;

export interface Cell {
  readonly row: number;
  readonly column: number;
}

interface SavedSsh {
  readonly target: string;
  readonly local: HerdrLab;
}

function savedEndpoint(lab: HerdrLab, target: string): string {
  const root = tempDir("herdr-client-state-");
  const client = join(root, "herdr", "client");
  mkdirSync(client, { recursive: true });
  const id = "0123456789abcdef0123456789abcdef";
  writeFileSync(
    join(client, "endpoints.json"),
    JSON.stringify({
      version: 1,
      selected_profile: id,
      ssh: [{ id, label: "lab host", target, session: lab.name, enabled: true }],
    }),
  );
  return root;
}

interface Placed {
  readonly rect: { x: number; y: number };
  readonly area: { width: number; height: number };
}

function numberOf(value: unknown, name: string): number {
  if (typeof value !== "number") throw new Error(`herdr layout has no ${name}`);
  return value;
}

function placedFrom(result: JsonRecord, pane: string): Placed {
  const [layout] = records([result["layout"]]);
  const [area] = records([layout?.["area"]]);
  const own = records(layout?.["panes"]).find((each) => each["pane_id"] === pane);
  const [rect] = records([own?.["rect"]]);
  if (area === undefined || rect === undefined) throw new Error(`herdr has no layout of ${pane}`);
  return {
    rect: { x: numberOf(rect["x"], "x"), y: numberOf(rect["y"], "y") },
    area: {
      width: numberOf(area["width"], "area width"),
      height: numberOf(area["height"], "area height"),
    },
  };
}

function scriptArguments(command: string): string[] {
  if (process.platform === "darwin") return ["-q", "/dev/null", "sh", "-c", command];
  return ["-qfec", command, "/dev/null"];
}

function clientEnvironment(
  lab: HerdrLab,
  env: Record<string, string>,
  remote: SavedSsh | undefined,
): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR")),
  );
  const front = env["PATH"] === undefined ? [] : [env["PATH"]];
  const state = remote === undefined ? {} : { XDG_STATE_HOME: savedEndpoint(lab, remote.target) };
  return {
    ...clean,
    ...env,
    ...state,
    HERDR_CONFIG_PATH: (remote?.local ?? lab).config,
    PATH: [...front, process.env["PATH"] ?? ""].join(delimiter),
    TERM: "xterm-256color",
    TERM_PROGRAM: "WezTerm",
  };
}

export class HerdrClient {
  private readonly lab: HerdrLab;
  private readonly child: ChildProcess;
  private readonly rows: number;
  private readonly columns: number;

  private constructor(lab: HerdrLab, child: ChildProcess, rows: number, columns: number) {
    this.lab = lab;
    this.child = child;
    this.rows = rows;
    this.columns = columns;
  }

  static async start(
    lab: HerdrLab,
    pane: string,
    env: Record<string, string>,
    size: { rows: number; columns: number } = { rows: 30, columns: 120 },
    remote?: SavedSsh,
  ): Promise<HerdrClient> {
    const before = placedFrom(await lab.run(["pane", "layout", "--pane", pane]), pane);
    const local = remote?.local ?? lab;
    const command = `stty rows ${String(size.rows)} cols ${String(size.columns)}; exec herdr --session ${local.name}`;
    const child = spawnGuarded("script", scriptArguments(command), {
      env: clientEnvironment(lab, env, remote),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const capture = (data: Buffer): void => {
      output = (output + data.toString()).slice(-8000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.stdin?.on("error", () => undefined);
    const client = new HerdrClient(lab, child, size.rows, size.columns);
    try {
      await client.attached(pane, before);
      return client;
    } catch (error) {
      client.stop();
      throw new Error(`${String(error)}\n${output}`, { cause: error });
    }
  }

  private async attached(pane: string, before: Placed): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const { area } = placedFrom(await this.lab.run(["pane", "layout", "--pane", pane]), pane);
      if (area.width !== before.area.width || area.height !== before.area.height) return;
      if (Date.now() > deadline) throw new Error("the herdr client did not attach");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async outer(pane: string, at: Cell): Promise<{ x: number; y: number }> {
    const placed = placedFrom(await this.lab.run(["pane", "layout", "--pane", pane]), pane);
    return {
      x: at.column + placed.rect.x + (this.columns - placed.area.width),
      y: at.row + 1 + placed.rect.y + (this.rows - placed.area.height),
    };
  }

  async click(pane: string, at: Cell, modifier: "plain" | "ctrl" = "plain"): Promise<void> {
    const { x, y } = await this.outer(pane, at);
    const report = `${String(modifier === "ctrl" ? CTRL : 0)};${String(x)};${String(y)}`;
    this.child.stdin?.write(`\u001b[<${report}M\u001b[<${report}m`);
  }

  stop(): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      return;
    }
  }
}
