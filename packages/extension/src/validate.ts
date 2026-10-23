import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPS } from "@fleet/protocol";
import Type from "typebox";
import type { Jobs } from "./jobs.ts";
import { callUrl } from "./jobs.ts";
import type { Link } from "./link.ts";

const DRIVER = fileURLToPath(new URL("./validate-run.ts", import.meta.url));
const VALIDATE_LABEL = "validate";
const DAY_MS = 24 * 60 * 60 * 1000;
const WAIT = "5m";
const PROBE_DELAYS_MS = (process.env["FLEET_VALIDATE_PROBES_MS"] ?? "10000,30000,90000")
  .split(",")
  .map(Number);
const TAIL_LINES = 400;

const ValidateParams = Type.Object({
  respond: OPS["validation.start"].args.properties.respond,
  answer: OPS["validation.start"].args.properties.answer,
  intent: OPS["validation.start"].args.properties.intent,
});

interface Params {
  readonly respond?: { action: string; findings?: string; instructions?: string };
  readonly answer?: { question: string; answer: string };
}

interface Plan {
  readonly mode: "run" | "rerun" | "respond" | "answer";
  readonly first: readonly string[];
  readonly reattach: readonly string[];
}

const REATTACH = ["axi", "run", "--wait", WAIT];

function planFor(params: Params, nonce: string, intent: string): Plan {
  if (params.respond !== undefined) {
    const { action, findings, instructions } = params.respond;
    const flags = [
      ...(findings === undefined ? [] : ["--findings", findings]),
      ...(instructions === undefined ? [] : ["--instructions", instructions]),
    ];
    return {
      mode: "respond",
      first: ["axi", "respond", "--action", action, ...flags, "--wait", WAIT],
      reattach: REATTACH,
    };
  }
  if (params.answer !== undefined)
    return {
      mode: "answer",
      first: [
        "axi",
        "answer",
        "--question",
        params.answer.question,
        "--answer",
        params.answer.answer,
      ],
      reattach: REATTACH,
    };
  const run = ["axi", "run", "--launch-nonce", nonce, "--intent", intent, "--wait", WAIT];
  return { mode: "run", first: run, reattach: run };
}

export class Validator {
  private readonly link: Link;
  private readonly jobs: Jobs;
  private readonly cardd: { url: string; token: string };

  constructor(link: Link, jobs: Jobs, cardd: { url: string; token: string }) {
    this.link = link;
    this.jobs = jobs;
    this.cardd = cardd;
  }

  private async drive(validation: number, plan: Plan): Promise<number> {
    const config = {
      url: callUrl(this.cardd.url),
      token: this.cardd.token,
      validation,
      mode: plan.mode,
      first: plan.first,
      reattach: plan.reattach,
      probeDelaysMs: PROBE_DELAYS_MS,
    };
    const env = {
      FLEET_VALIDATE: JSON.stringify(config),
      PATH: process.env["PATH"] ?? "",
    };
    const { job } = await this.jobs.launch(VALIDATE_LABEL, `node ${DRIVER}`, {
      timeoutMs: DAY_MS,
      tailLines: TAIL_LINES,
      env,
    });
    return job;
  }

  async rerun(validation: number): Promise<void> {
    await this.drive(validation, { mode: "rerun", first: ["rerun"], reattach: REATTACH });
  }

  register(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "validate",
      label: "Validate",
      description:
        "Runs, or continues, your card's no-mistakes pipeline through fleet, and returns at once. The run is tied to your card, it reattaches by itself when a wait ends, and your first mate is told once if the run fails. Its gate or outcome arrives later as a [fleet] message. validate() starts the run with the card's intent (pass intent only when the card has none). validate(respond={action, findings?, instructions?}) answers the gate. validate(answer={question, answer}) answers a reviewer question. Never run no-mistakes axi run, respond, answer, or rerun yourself, and never its daemon commands.",
      parameters: ValidateParams,
      execute: async (_id, params) => {
        const started = await this.link.call("validation.start", params);
        const label = `validation ${String(started.validation)}`;
        if (started.reused && this.jobs.has(VALIDATE_LABEL))
          return reply(
            `${label} is already driving the run. Its gate or outcome arrives as a [fleet] message.`,
          );
        const plan = planFor(params, started.nonce, started.intent);
        const job = await this.drive(started.validation, plan);
        return reply(
          `Started ${label} as job ${String(job)}. It posts the run to fleet, reattaches by itself, and its gate or outcome arrives as a [fleet] message; you may end this run.`,
        );
      },
    });
  }
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
