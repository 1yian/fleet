import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPS } from "@fleet/protocol";
import Type from "typebox";
import { replaceWorker, type Launch } from "./dispatch.ts";
import { restartLane } from "./lanes.ts";
import type { Link } from "./link.ts";

const RecoverParams = Type.Object({
  incident: OPS["incident.recover"].args.properties.incident,
  generation: OPS["incident.recover"].args.properties.generation,
  mode: OPS["incident.recover"].args.properties.mode,
  key: Type.Optional(OPS["incident.recover"].args.properties.key),
});

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function registerRecover(
  pi: ExtensionAPI,
  link: Link,
  launch: Launch,
  home: string | undefined,
): void {
  pi.registerTool({
    name: "recover",
    label: "Recover",
    description:
      "Recovers a worker or second mate that has a runtime failure incident, named in a [fleet] runtime failure message you got as its direct parent. mode=retry sends it a recovery check on its live process. mode=replace starts a new process on the same conversation, branch, and work. Name the incident and the process generation the message gave: a changed generation is refused. Recovery only checks health: the actor answers and acts once, and nothing paused or finished is resumed. An incident is verified only by a real answer and an action, not by a process starting. Never restarts main or cardd.",
    parameters: RecoverParams,
    execute: async (_id, params) => {
      const key = params.key ?? randomUUID();
      const plan = await link.call("incident.recover", { ...params, key });
      const who = plan.role === "worker" ? `the worker on c-${String(plan.card)}` : plan.actor;
      if (plan.mode === "retry")
        return reply(
          `Sent a recovery check to ${who} (incident ${String(plan.incident)}). You hear once whether it answered and acted.`,
        );
      if (plan.replaced)
        return reply(`${who} already runs a new process (incident ${String(plan.incident)}).`);
      const started =
        plan.role === "worker"
          ? await replaceWorker(link, launch, plan)
          : home === undefined
            ? undefined
            : await restartOnce(home, plan);
      if (started === undefined)
        throw new Error(`only main can replace the process of ${plan.actor}`);
      return reply(
        `${started} The recovery check reaches it when it connects (incident ${String(plan.incident)}). You hear once whether it answered and acted.`,
      );
    },
  });
}

async function restartOnce(home: string, plan: { lane: string; repeat: boolean }): Promise<string> {
  if (plan.repeat)
    return `A restart of ${plan.lane} was already requested, so this repeat did nothing.`;
  return restartLane(home, plan.lane);
}
