import type { ChildProcess } from "node:child_process";
import { delimiter } from "node:path";
import { spawnGuarded } from "./guarded.ts";
import type { HerdrLab } from "./herdr.ts";
import { records, type JsonRecord } from "./json.ts";

const WAIT_MS = 30_000;
const CTRL = 16;

export interface Cell {
  readonly row: number;
  readonly column: number;
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
  ): Promise<HerdrClient> {
    const before = placedFrom(await lab.run(["pane", "layout", "--pane", pane]), pane);
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR")),
    );
    const front = env["PATH"] === undefined ? [] : [env["PATH"]];
    const child = spawnGuarded(
      "script",
      [
        "-qfec",
        `stty rows ${String(size.rows)} cols ${String(size.columns)}; exec herdr --session ${lab.name}`,
        "/dev/null",
      ],
      {
        env: {
          ...clean,
          ...env,
          PATH: [...front, process.env["PATH"] ?? ""].join(delimiter),
          TERM: "xterm-256color",
          TERM_PROGRAM: "ghostty",
        },
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    child.stdin?.on("error", () => undefined);
    const client = new HerdrClient(lab, child, size.rows, size.columns);
    await client.attached(pane, before);
    return client;
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
      x: at.column + 1 + placed.rect.x + (this.columns - placed.area.width),
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
