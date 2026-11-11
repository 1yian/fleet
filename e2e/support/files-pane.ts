import assert from "node:assert/strict";
import type { HerdrLab } from "./herdr.ts";
import { records } from "./json.ts";
import type { FilesFleet } from "./files-fleet.ts";

const WAIT_MS = 30_000;

export class FilesPane {
  readonly lab: HerdrLab;
  readonly pane: string;

  private constructor(lab: HerdrLab, pane: string) {
    this.lab = lab;
    this.pane = pane;
  }

  static attach(lab: HerdrLab, pane: string): FilesPane {
    return new FilesPane(lab, pane);
  }

  static async open(
    lab: HerdrLab,
    fleet: FilesFleet,
    options: { label?: string; path?: string; command?: string } = {},
  ): Promise<FilesPane> {
    const created = await lab.run([
      "workspace",
      "create",
      "--cwd",
      fleet.home,
      "--label",
      options.label ?? "files",
      "--no-focus",
    ]);
    const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
    const env = fleet.env({ PATH: options.path ?? process.env["PATH"] ?? "" });
    const assignments = Object.entries(env)
      .map(([name, value]) => `${name}='${value}'`)
      .join(" ");
    const command = options.command ?? `node '${fleet.scratch.launch}' files`;
    await lab.submit(pane, `cd '${fleet.home}' && env ${assignments} ${command}`);
    return new FilesPane(lab, pane);
  }

  async screen(): Promise<string> {
    return this.lab.screen(this.pane);
  }

  async sees(text: string | RegExp, what = String(text)): Promise<string> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const screen = await this.screen();
      const found = typeof text === "string" ? screen.includes(text) : text.test(screen);
      if (found) return screen;
      assert.ok(Date.now() < deadline, `timed out waiting for ${what} on:\n${screen}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async type(text: string): Promise<void> {
    await this.lab.type(this.pane, text);
  }

  async press(...keys: string[]): Promise<void> {
    await this.lab.press(this.pane, ...keys);
  }

  async hover(name: string): Promise<void> {
    await this.type("f");
    await this.sees("Filter:");
    await this.type(name);
    await this.press("enter");
    await this.sees(`(filter: ${name})`);
  }
}
