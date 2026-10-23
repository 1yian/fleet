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
  avoid: OPS["card.restart"].args.properties.avoid,
});

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function registerRestart(
  pi: ExtensionAPI,
  link: Link,
  launch: Launch,
  home: string | undefined,
): void {
  pi.registerTool({
    name: "restart_card",
    label: "Restart card",
    description:
      "Restarts your worker on the SAME card, conversation, branch, and work, with or without a runtime incident. Only its direct parent may restart it; main may restart a second mate by its lane card, never main or cardd. Default mode=replace. With incident, name its generation too: stale generations are refused; mode=retry sends a health check instead. Never resumes paused or completed work. Ordinary restarts are capped at 3 per hour per card. Repeat the same key for an idempotent retry. avoid lists exact provider names the new process must not use, for this restart only (replace of a worker only); a later restart without avoid clears it.",
    parameters: RestartParams,
    execute: async (_id, params) => {
      const key = params.key ?? randomUUID();
      const request = { ...params, mode: params.mode ?? "replace", key };
      const plan = await link.call("card.restart", request);
      return reply(await carryOut(link, launch, home, plan, params.avoid));
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
  avoid: readonly string[] | undefined,
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
  const started = await replaceWorker(link, launch, plan, avoid);
  if (plan.incident !== null)
    return `${started} The recovery check reaches it when it connects${incident}. ${CHECK_NOTE}`;
  if (!plan.repeat) await link.call("comment", { card: plan.card, text: RESTARTED_NOTE });
  return started;
}
