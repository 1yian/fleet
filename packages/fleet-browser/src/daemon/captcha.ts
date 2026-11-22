import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import type { Lane } from "./lane.js";

export interface CaptchaResult {
  outcome: "solved" | "failed" | "none" | "error" | "detected";
  kind?: string;
  captchas?: Array<{ kind: string; visible: boolean }>;
  reason?: string;
  seconds?: number;
  model?: Record<string, number>;
  [key: string]: unknown;
}

export class Captcha {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async run(lane: Lane, command: "solve" | "detect", kind: string, target?: string): Promise<CaptchaResult> {
    const settings = this.config.captcha;
    if (!settings)
      throw new HttpError(503, "captcha solving is not configured on this host (config captcha block)");
    if (command === "solve" && !settings.model)
      throw new HttpError(503, "captcha.model is not set in the host config");
    const key = command === "solve" ? this.readKey(settings.keyFile) : "";
    await lane.start();
    const page = await lane.pageFor(target);
    const release = lane.beginStep("captcha");
    lane.activate(page.id);
    try {
      return await this.spawnSolver(settings, lane.cdpPort, page.id, command, kind, key);
    } finally {
      release();
    }
  }

  private readKey(path: string): string {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      throw new HttpError(503, `the captcha solver key file ${path} is missing or unreadable`);
    }
  }

  private spawnSolver(
    settings: NonNullable<Config["captcha"]>,
    cdpPort: number,
    target: string,
    command: string,
    kind: string,
    key: string,
  ): Promise<CaptchaResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        join(settings.dir, ".venv", "bin", "python"),
        [
          "-m",
          "fleet_browser_solver",
          command,
          "--cdp",
          `http://127.0.0.1:${cdpPort}`,
          "--target",
          target,
          "--kind",
          kind,
          "--budget",
          String(settings.budgetSeconds),
        ],
        {
          cwd: join(settings.dir, "src"),
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: this.config.dataDir,
            OPENAI_API_KEY: key,
            FLEET_BROWSER_SOLVER_MODEL: settings.model ?? "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), (settings.budgetSeconds + 45) * 1000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new HttpError(502, `could not start the captcha solver: ${error.message}`));
      });
      child.once("close", () => {
        clearTimeout(timer);
        const line = stdout.trim().split("\n").pop() ?? "";
        try {
          resolve(JSON.parse(line) as CaptchaResult);
        } catch {
          reject(
            new HttpError(
              502,
              `the captcha solver gave no result: ${stderr.trim().slice(-200) || "no output"}`,
            ),
          );
        }
      });
    });
  }
}
