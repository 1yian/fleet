import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WAKE_DAYS, type Plan } from "@fleet/protocol";
import type { Link } from "./link.ts";

type Wake = Plan["wakes"][number];

const cadence = ({ at, days }: Wake): string => {
  const on = days === undefined || days.length === WAKE_DAYS.length ? "day" : days.join(", ");
  return `every ${on} at ${at}`;
};

function planPrompt(plan: Plan): string {
  const goal = plan.goal.trim();
  if (goal === "" && plan.wakes.length === 0) return "";
  const parts = ["## Your goal and scheduled wakes"];
  if (goal !== "")
    parts.push(
      "Your lane card holds your goal and standing instructions. They bind you: stay inside every limit they state.",
      `Goal:\n\n${goal}`,
    );
  if (plan.wakes.length > 0)
    parts.push(
      `Scheduled wakes, in the time zone ${plan.timezone}:\n${plan.wakes.map((wake) => `- ${cadence(wake)}: ${wake.purpose}`).join("\n")}`,
      'Each one reaches you as "[fleet] scheduled wake <time>: <purpose>" and owes a reply. A wake is a nudge, never an order to start work: it dispatches no worker and makes no card. Do what its purpose asks, inside your goal\'s limits, then answer it with the comment that the message names, in one line on what you did or why you did nothing. A wake you leave unanswered is resent once, then main hears of it, and later wakes are skipped until you answer. A script can also wake you with "[fleet] script wake <name>: <note>": read the note and act on it as you judge; it owes no reply.',
    );
  return parts.join("\n\n");
}

export function registerPlan(pi: ExtensionAPI, link: Link): void {
  let plan: Plan | undefined;
  let loading: Promise<void> | undefined;
  const load = (): void => {
    if (plan !== undefined || loading !== undefined) return;
    loading = link
      .call("lane.plan", {})
      .then(
        (loaded) => {
          plan = loaded;
        },
        () => undefined,
      )
      .finally(() => {
        loading = undefined;
      });
  };
  pi.events.on("fleet:connected", load);
  pi.on("before_agent_start", async (event) => {
    await loading;
    const text = plan === undefined ? "" : planPrompt(plan);
    return text === "" ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${text}` };
  });
}
