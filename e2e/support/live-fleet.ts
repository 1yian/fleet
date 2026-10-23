import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, CardSchema, OPS, type BoardCard } from "@fleet/protocol";
import { Cardd, type Session } from "./cardd.ts";
import { Harness, type Turn } from "./harness.ts";
import { HerdrLab } from "./herdr.ts";
import { optionalString, records } from "./json.ts";
import { addRemote, git, landOnRemote } from "./remote.ts";
import { tempDir } from "./run-root.ts";
import { configureMain, mateArgs, Scratch, startMain } from "./scratch.ts";

const WAIT_MS = 120_000;
export const NEW_CODE = "NEW-CODE-MARKER";
const BIN = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
const TRANSPORT = fileURLToPath(new URL("./switch-transport.ts", import.meta.url));
const PROBE = fileURLToPath(new URL("./probe.ts", import.meta.url));
const EXTENSION = join("packages", "extension", "src", "index.ts");

export async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export interface Worker {
  readonly session: string;
  readonly card: number;
  readonly branch: string;
  readonly worktree: string;
  readonly pane: string;
  readonly host: string;
}

export const lastUser = (turns: readonly Turn[]): string =>
  turns.findLast((turn) => turn.role === "user")?.text ?? "";
export const systemOf = (turns: readonly Turn[]): string =>
  turns.find((turn) => turn.role === "system")?.text ?? "";

interface Parts {
  readonly h: Harness;
  readonly cardd: Cardd;
  readonly lab: HerdrLab;
  readonly here: Scratch;
  readonly p620: Scratch;
  readonly remote: string;
  readonly ghost: Session;
  readonly opsHome: string;
  readonly farHome: string;
  readonly site: string;
  readonly gates: string;
}

export class LiveFleet {
  readonly h: Harness;
  readonly cardd: Cardd;
  readonly lab: HerdrLab;
  readonly here: Scratch;
  readonly p620: Scratch;
  readonly remote: string;
  readonly ghost: Session;
  readonly opsHome: string;
  readonly farHome: string;
  readonly site: string;
  readonly gates: string;
  mainPane = "";

  private constructor(parts: Parts) {
    this.h = parts.h;
    this.cardd = parts.cardd;
    this.lab = parts.lab;
    this.here = parts.here;
    this.p620 = parts.p620;
    this.remote = parts.remote;
    this.ghost = parts.ghost;
    this.opsHome = parts.opsHome;
    this.farHome = parts.farHome;
    this.site = parts.site;
    this.gates = parts.gates;
  }

  static async start(env: Record<string, string> = {}): Promise<LiveFleet> {
    const cardd = await Cardd.start();
    const h = await Harness.start();
    const here = new Scratch();
    const remote = addRemote(here.root);
    const p620 = new Scratch("fleet");
    git(p620.root, "remote", "add", "origin", remote);
    git(p620.root, "fetch", "-q", "origin");
    git(p620.root, "reset", "-q", "--hard", "origin/main");
    const mainToken = cardd.addLane("main", undefined, here.root);
    configureMain(here, cardd.url, mainToken, {
      hosts: { p620: ["node", TRANSPORT, join(here.parent, "p620-down")] },
      roots: { p620: p620.root },
    });
    const args = [
      ...mateArgs(h).filter((arg) => !["--no-context-files", "--no-builtin-tools"].includes(arg)),
      "-e",
      PROBE,
    ];
    const lane = (name: string) => ({
      url: cardd.url,
      token: cardd.addLane(name, "main"),
      args,
    });
    const opsHome = here.addLane("ops", lane("ops"));
    const farHome = p620.addLane("far", lane("far"));
    const ghost = await cardd.connect(cardd.addLane("ghost", "main"));
    const site = join(tempDir("fleet-site-"), "site");
    mkdirSync(site, { recursive: true });
    git(site, "init", "-q", "-b", "main");
    git(site, "commit", "-q", "--allow-empty", "-m", "init");
    cardd.addProject("site", { local: site, p620: site });
    const gates = tempDir("fleet-gates-");
    const lab = await HerdrLab.start({
      ...h.piEnv("mate"),
      PATH: `${BIN}:${process.env["PATH"] ?? ""}`,
      FLEET_SUPERVISE_MS: "1000",
      ...env,
    });
    return new LiveFleet({
      h,
      cardd,
      lab,
      here,
      p620,
      remote,
      ghost,
      opsHome,
      farHome,
      site,
      gates,
    });
  }

  async startMain(): Promise<string> {
    this.mainPane = await startMain(this.lab, this.here, this.h);
    return this.mainPane;
  }

  async stop(): Promise<void> {
    const stopped = await Promise.allSettled([
      this.ghost.close(),
      this.lab.stop(),
      this.h.stop(),
      this.cardd.stop(),
    ]);
    this.here.dispose();
    this.p620.dispose();
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
  }

  gate(name: string): string {
    return join(this.gates, name);
  }

  open(name: string): void {
    writeFileSync(this.gate(name), "");
  }

  landCode(): string {
    let tip = "";
    for (const role of ["worker", "mate"]) {
      const file = `packages/extension/prompts/${role}.md`;
      const text = `${readFileSync(join(this.here.root, file), "utf8")}\n${NEW_CODE}\n`;
      tip = landOnRemote(this.remote, `${NEW_CODE} ${role}`, file, text);
    }
    return tip;
  }

  async paneOf(label: string): Promise<string | undefined> {
    const workspaces = records((await this.lab.run(["workspace", "list"]))["workspaces"]);
    const workspace = workspaces.find((each) => each["label"] === label);
    if (workspace === undefined) return undefined;
    const panes = await this.lab.run([
      "pane",
      "list",
      "--workspace",
      String(workspace["workspace_id"]),
    ]);
    const pane = records(panes["panes"])[0];
    return pane === undefined ? undefined : optionalString(pane, "pane_id");
  }

  async piIn(pane: string): Promise<number | undefined> {
    const info = await this.lab.run(["pane", "process-info", "--pane", pane]);
    const first = records([info["process_info"]])[0];
    const pi = records(first?.["foreground_processes"]).find(
      (each) => each["name"] === "pi" || each["argv0"] === "pi",
    );
    return pi === undefined ? undefined : Number(pi["pid"]);
  }

  async matePid(lane: string): Promise<number> {
    const label = lane === "main" ? "1stmate" : `2ndmate-${lane}`;
    return until(async () => {
      const pane = await this.paneOf(label);
      return pane === undefined ? undefined : this.piIn(pane);
    }, `${lane} to run Pi`);
  }

  async newPid(pane: string, old: number): Promise<number> {
    return until(async () => {
      const now = await this.piIn(pane);
      return now !== undefined && now !== old ? now : undefined;
    }, `pane ${pane} to run a new Pi`);
  }

  async startWorker(title: string, host: string): Promise<Worker> {
    const card = check(
      CardSchema,
      await this.ghost.call("card.new", { title, kind: "scout", project: "site" }),
    );
    const begun = check(
      OPS["attempt.begin"].result,
      await this.ghost.call("attempt.begin", { card: card.id, host, task: `START-${title}` }),
    );
    const worktree = `${this.site}.worktrees/${begun.session}`;
    git(this.site, "worktree", "add", "-q", "-b", begun.branch, worktree, "main");
    const created = await this.lab.run([
      "workspace",
      "create",
      "--cwd",
      worktree,
      "--label",
      begun.session,
      "--no-focus",
    ]);
    const pane = String(records([created["root_pane"]])[0]?.["pane_id"]);
    const ext = join(host === "p620" ? this.p620.root : this.here.root, EXTENSION);
    const flags = [
      `--fleet-url=${this.cardd.url}`,
      `--fleet-token=${begun.token}`,
      "--fleet-role=worker",
      "--session-id",
      begun.session,
      ...this.h.piArgs().filter((arg) => arg !== "--no-builtin-tools"),
      "-e",
      ext,
      "-e",
      PROBE,
    ];
    await this.lab.submit(pane, "export FLEET_FAKE_AGENT=worker");
    await this.lab.submit(pane, `pi ${flags.map((arg) => `'${arg}'`).join(" ")}`);
    return { session: begun.session, card: card.id, branch: begun.branch, worktree, pane, host };
  }

  async board(): Promise<BoardCard[]> {
    return check(OPS.board.result, await this.ghost.call("board", {}));
  }

  async cardOf(card: number): Promise<BoardCard> {
    const found = (await this.board()).find((each) => each.id === card);
    if (found === undefined) throw new Error(`c-${String(card)} is not on the board`);
    return found;
  }

  sessionEvents(cwd: string): Record<string, unknown>[] {
    return this.h.events.filter((event) => event["type"] === "session" && event["cwd"] === cwd);
  }

  heardBy(agent: string, prefix: string): Turn[] | undefined {
    return this.h
      .callsOf(agent)
      .find((turns) => turns.some((turn) => turn.text.startsWith(prefix)));
  }

  userTexts(agent: string): string[] {
    return this.h.callsOf(agent).map(lastUser);
  }
}
