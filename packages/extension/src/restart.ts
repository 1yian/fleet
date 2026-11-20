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
  model: OPS["card.restart"].args.properties.model,
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
      "Restarts your worker on the SAME card, conversation, branch, and work, with or without a runtime incident. Only its direct parent may restart it; main may restart a second mate by its lane card, never main or cardd. Default mode=replace. With incident, name its generation too: stale generations are refused; mode=retry sends a health check instead. Never resumes paused or completed work: for a card that is paused, finished, or waiting, it replaces only a worker whose process is disconnected (as after a cardd restart that left it unable to connect), sends it nothing, and leaves the card as it was, so a comment or the wake that you send next reaches it. Ordinary restarts are capped at 3 per hour per card, and only a restart that ran counts: a refused one, or one whose process could not be started, does not. Repeat the same key for an idempotent retry; a key whose restart did not run starts it again. avoid lists exact provider names the new process must not use, for this restart only (replace of a worker only); a later restart without avoid clears it. A worker dispatched with an explicit model keeps it, so an avoid that names that model's provider is refused. A pinned model on one account of a tiers.json account group does not pin the account: the worker moves to another account of the group that serves the same model when its own is throttled or out of quota, and avoid may name another account of the group. model=provider/id (such as tier/visual) sets the worker's model whether or not it was dispatched with an explicit model, on the same card, conversation, branch, and PR, and every later restart keeps it. Only the card's own mate can set it, only when the worker's process is replaced, and a refused or repeated restart changes nothing. Use it when the current model's account cannot serve the work; avoid is then checked against the new model.",
    parameters: RestartParams,
    execute: async (_id, params) => {
      const key = params.key ?? randomUUID();
      const request = { ...params, mode: params.mode ?? "replace", key };
      const plan = await link.call("card.restart", request);
      return reply(await carryOut(link, launch, home, plan, key, params.avoid));
    },
  });
}

type Plan = OpResult<"card.restart">;

const RESTARTED_NOTE =
  "Your session was restarted on the same card and conversation. Continue your task from where you stopped.";
const CHECK_NOTE =
  "You hear once whether it answered and acted. Nothing paused or finished is resumed.";

async function launching<T>(
  link: Link,
  plan: Plan,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  try {
    return await start();
  } catch (error) {
    if (!plan.repeat && plan.incident === null) {
      const reason = error instanceof Error ? error.message : String(error);
      await link
        .call("card.restart.failed", { card: plan.card, key, error: reason })
        .catch(() => undefined);
    }
    throw error;
  }
}

const incidentOf = (plan: Plan): string =>
  plan.incident === null ? "" : ` (incident ${String(plan.incident)})`;

async function restartMate(
  link: Link,
  home: string | undefined,
  plan: Plan,
  key: string,
): Promise<string> {
  if (home === undefined) throw new Error(`only main can replace the process of ${plan.actor}`);
  return plan.repeat
    ? `A restart of ${plan.lane} was already requested, so this repeat did nothing.`
    : await launching(link, plan, key, () => restartLane(home, plan.lane));
}

async function restartWorker(
  link: Link,
  launch: Launch,
  plan: Plan,
  key: string,
  avoid: readonly string[] | undefined,
): Promise<string> {
  const notice = plan.incident === null && plan.reconnect !== true ? RESTARTED_NOTE : undefined;
  const started = await launching(link, plan, key, () =>
    replaceWorker(link, launch, { ...plan, notice }, avoid),
  );
  if (plan.incident !== null)
    return `${started} The recovery check reaches it when it connects${incidentOf(plan)}. ${CHECK_NOTE}`;
  return plan.reconnect === true
    ? `${started} The card keeps its state: nothing was resumed, and what you send it next reaches it.`
    : started;
}

async function carryOut(
  link: Link,
  launch: Launch,
  home: string | undefined,
  plan: Plan,
  key: string,
  avoid: readonly string[] | undefined,
): Promise<string> {
  const who = plan.role === "worker" ? `the worker on c-${String(plan.card)}` : plan.actor;
  if (plan.mode === "retry")
    return `Sent a recovery check to ${who}${incidentOf(plan)}. ${CHECK_NOTE}`;
  if (plan.replaced) return `${who} already runs a new process${incidentOf(plan)}.`;
  return plan.role === "mate"
    ? restartMate(link, home, plan, key)
    : restartWorker(link, launch, plan, key, avoid);
}
