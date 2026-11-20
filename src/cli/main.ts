import { AxiError, runAxiCli } from "axi-sdk-js";
import {
  cleanOutput,
  guardTabClose,
  mergedConsole,
  ownTab,
  PASS_THROUGH,
  runAgentBrowser,
} from "./browser.js";
import { captchaCommand } from "./captcha.js";
import { daemon } from "./client.js";
import { brokerStatus, loginCommand, mailCommand, otpCommand } from "./credentials.js";
import { devCommand } from "./dev.js";
import { parseDuration } from "./duration.js";
import { askCaptain, waitForHandoff } from "./handoff.js";
import { listLanes, renderLanes, watchLanes } from "./lanes.js";
import { renderStatus } from "./status.js";

const HELP = `usage: fleet-browser <command> [args]
commands[10]:
  (none)                          lane status: browser, control, tabs, pending handoff
  open <url>                      open a page in this lane's persistent Chrome
  snapshot [-i] | click @e | fill @e <text> | type | press | scroll | wait | screenshot <path> | eval | get | find | tab | back | reload
                                  browser verbs, passed to agent-browser (run \`fleet-browser snapshot -i\` first)
  login <item> | otp <item> [--submit] | mail link|code <item> [--match <re>] [--since 10m] [--wait 60s] [--submit]
                                  fill credentials from the lane vault; you never see the secrets
  captcha [detect] [--kind hcaptcha|recaptcha] [--no-handoff]
                                  solve the captcha on the page with the vision-model solver; hands the lane to the captain if it cannot
  dev [--headful] [--name <n>] <verb> ...
                                  throwaway browser for your own dev server: headless on this machine, or a fresh headful lane on the browser host with a board viewer (--headful); "dev close" deletes it
  broker status                   1Password read budget for the account
  handoff "<reason>" [--wait 30m] ask the captain to take over in the board; waits until Done
  handoff wait | cancel | status
  status [--watch] | start | stop | restart | lanes [--watch --notify]
flags: --lane <name> overrides FLEET_BROWSER_LANE`;

function takeLane(args: string[]): { lane: string; rest: string[] } {
  const rest = [...args];
  const at = rest.indexOf("--lane");
  let lane = process.env.FLEET_BROWSER_LANE;
  if (at !== -1) {
    lane = rest[at + 1];
    rest.splice(at, 2);
  }
  if (!lane) {
    throw new AxiError("no lane selected", "NO_LANE", [
      "Set FLEET_BROWSER_LANE=<lane> in the lane's environment",
      "Or pass --lane <name>",
    ]);
  }
  return { lane, rest };
}

async function passThrough(verb: string, args: string[]): Promise<string> {
  const { lane, rest } = takeLane(args);
  await daemon.start(lane);
  await guardTabClose(lane, verb, rest);
  if (verb === "console") return mergedConsole((a) => runAgentBrowser(lane, a), rest);
  const result = await runAgentBrowser(lane, [verb, ...rest]);
  const text = cleanOutput(result.stdout + result.stderr).trimEnd();
  if (result.code !== 0)
    throw new AxiError(text || `agent-browser exited with ${result.code}`, "BROWSER_COMMAND_FAILED");
  return text;
}

async function laneStatus(lane: string) {
  const snapshot = await daemon.snapshot(lane);
  const own = snapshot.status === "ready" ? await ownTab(lane).catch(() => undefined) : undefined;
  return renderStatus(snapshot, own);
}

const commands = {
  status: async (args: string[]) => {
    const { lane, rest } = takeLane(args);
    if (rest.includes("--watch")) {
      await watchStatus(lane);
      return "";
    }
    return laneStatus(lane);
  },
  start: async (args: string[]) => renderStatus(await daemon.start(takeLane(args).lane)),
  stop: async (args: string[]) => renderStatus(await daemon.stop(takeLane(args).lane)),
  restart: async (args: string[]) => renderStatus(await daemon.restart(takeLane(args).lane)),
  handoff: async (args: string[]) => handoffCommand(args),
  login: async (args: string[]) => {
    const { lane, rest } = takeLane(args);
    return loginCommand(lane, rest);
  },
  otp: async (args: string[]) => {
    const { lane, rest } = takeLane(args);
    return otpCommand(lane, rest);
  },
  mail: async (args: string[]) => {
    const { lane, rest } = takeLane(args);
    return mailCommand(lane, rest);
  },
  dev: async (args: string[]) => devCommand(args),
  captcha: async (args: string[]) => {
    const { lane, rest } = takeLane(args);
    return captchaCommand(lane, rest);
  },
  broker: async (args: string[]) => {
    const { lane } = takeLane(args);
    return brokerStatus(lane);
  },
  lanes: async (args: string[]) => {
    if (args.includes("--watch")) {
      await watchLanes(args.includes("--notify"));
      return "";
    }
    return renderLanes(await listLanes(), args.includes("--plain"));
  },
  ...Object.fromEntries([...PASS_THROUGH].map((verb) => [verb, (args: string[]) => passThrough(verb, args)])),
};

async function watchStatus(lane: string): Promise<void> {
  let last = "";
  for (;;) {
    const text = JSON.stringify(
      await daemon.snapshot(lane).catch((error: Error) => ({ error: error.message })),
    );
    if (text !== last) {
      last = text;
      process.stdout.write(`\x1b[2J\x1b[H${renderText(JSON.parse(text))}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function renderText(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, v]) => `${key}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}

async function handoffCommand(args: string[]) {
  const { lane, rest } = takeLane(args);
  const sub = rest[0];
  if (sub === "status") return { handoff: (await daemon.currentHandoff(lane)) ?? "none" };
  if (sub === "cancel") {
    const current = await daemon.currentHandoff(lane);
    if (!current) return { handoff: "none open" };
    return { handoff: (await daemon.cancelHandoff(lane, current.id)).status };
  }
  if (sub === "wait") return waitForHandoff(lane, await daemon.currentHandoff(lane));
  let waitSeconds = 1800;
  const waitAt = rest.indexOf("--wait");
  if (waitAt !== -1) {
    waitSeconds = parseDuration(rest[waitAt + 1] ?? "");
    rest.splice(waitAt, 2);
  }
  const reason = rest.join(" ").trim();
  if (!reason)
    throw new AxiError("a reason is required", "NO_REASON", [
      'Run `fleet-browser handoff "solve the captcha on the page"`',
    ]);
  return askCaptain(lane, reason, waitSeconds, await ownTab(lane).catch(() => undefined));
}

await runAxiCli({
  description: "Agent browser: a persistent real Chrome per lane, with captain handoff",
  version: "0.1.0",
  topLevelHelp: HELP,
  home: async () => {
    const { lane } = takeLane([]);
    return laneStatus(lane);
  },
  commands,
});
