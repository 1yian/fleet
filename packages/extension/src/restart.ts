import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPS, type OpResult } from "@fleet/protocol";
import Type from "typebox";
import { replaceWorker, type Launch } from "./dispatch.ts";
import { restartLane } from "./lanes.ts";
import type { Link } from "./link.ts";

const RestartParams = Type.Object({
  card: Type.Integer(),
  incident: OPS["card.restart"].args.properties.incident,
  generation: OPS["card.restart"].args.properties.generation,
  mode: Type.Optional(OPS["card.restart"].args.properties.mode),
  key: Type.Optional(OPS["card.restart"].args.properties.key),
});

const RevalidateParams = Type.Object({
  validation: OPS["validation.revalidate"].args.properties.validation,
  generation: OPS["validation.revalidate"].args.properties.generation,
  key: Type.Optional(OPS["validation.revalidate"].args.properties.key),
});

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function registerRestart(
  pi: ExtensionAPI,
  link: Link,
  launch: Launch,
  home: string | undefined,
): void {
  pi.registerTool({
    name: "revalidate",
    label: "Revalidate",
    description:
      "Reruns the failed no-mistakes run of a worker's card, named in a [fleet] validation failed message you got as its direct parent. The rerun is on the same card, branch, and PR, and the worker's pipeline history is kept. Name the validation and the worker's process generation the message gave. Fleet never reruns by itself and never starts, stops, or restarts the no-mistakes daemon: a daemon that is down is reported to you and nothing more. At most 3 revalidations per card. A repeated request with the same key does nothing.",
    parameters: RevalidateParams,
    execute: async (_id, params) => {
      const key = params.key ?? randomUUID();
      const done = await link.call("validation.revalidate", { ...params, key });
      if (done.repeat)
        return reply(
          `c-${String(done.card)} already has this revalidation (validation ${String(done.validation)}), so this repeat did nothing.`,
        );
      return reply(
        `Asked the worker on c-${String(done.card)} to rerun its pipeline (validation ${String(done.validation)}, revalidation ${String(done.attempts)} of 3). Its gate or outcome reaches the worker, and a failure reaches you once.`,
      );
    },
  });
  pi.registerTool({
    name: "restart_card",
    label: "Restart card",
    description:
      "Restarts your worker on the SAME card, conversation, branch, and work, with or without a runtime incident. Only its direct parent may restart it; main may restart a second mate by its lane card, never main or cardd. Default mode=replace. With incident, name its generation too: stale generations are refused; mode=retry sends a health check instead. Never resumes paused or completed work. Ordinary restarts are capped at 3 per hour per card. Repeat the same key for an idempotent retry.",
    parameters: RestartParams,
    execute: async (_id, params) => {
      const key = params.key ?? randomUUID();
      const request = { ...params, mode: params.mode ?? "replace", key };
      const plan = await link.call("card.restart", request);
      return reply(await carryOut(link, launch, home, plan));
    },
  });
}

type Plan = OpResult<"card.restart">;

const RESTARTED_NOTE =
  "Your session was restarted on the same card and conversation. Continue your task from where you stopped.";
const CHECK_NOTE =
  "You hear once whether it answered and acted. Nothing paused or finished is resumed.";

async function carryOut(
  link: Link,
  launch: Launch,
  home: string | undefined,
  plan: Plan,
): Promise<string> {
  const who = plan.role === "worker" ? `the worker on c-${String(plan.card)}` : plan.actor;
  const incident = plan.incident === null ? "" : ` (incident ${String(plan.incident)})`;
  if (plan.mode === "retry") return `Sent a recovery check to ${who}${incident}. ${CHECK_NOTE}`;
  if (plan.replaced) return `${who} already runs a new process${incident}.`;
  if (plan.role === "mate") {
    if (home === undefined) throw new Error(`only main can replace the process of ${plan.actor}`);
    return plan.repeat
      ? `A restart of ${plan.lane} was already requested, so this repeat did nothing.`
      : await restartLane(home, plan.lane);
  }
  const started = await replaceWorker(link, launch, plan);
  if (plan.incident !== null)
    return `${started} The recovery check reaches it when it connects${incident}. ${CHECK_NOTE}`;
  if (!plan.repeat) await link.call("comment", { card: plan.card, text: RESTARTED_NOTE });
  return started;
}
