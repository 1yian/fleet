import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPS, type OpResult } from "@fleet/protocol";
import type { Link } from "./link.ts";

const REDEEM_DEADLINE_MS = 10_000;
const BROWSER_DEADLINE_MS = 90_000;
const MAX_OUTPUT = 16 * 1024;
const OUTCOME = /^login: (done|no-form|off-origin|stuck)\s*$/m;

const SAID = {
  done: "The lane's browser submitted the sign-in and no login fields are left. Verify the signed-in state with snapshot before you continue.",
  "no-form":
    "The page had no same-origin POST sign-in form with a password field, so nothing was typed.",
  "off-origin": "The page was not on the granted origin, so nothing was typed.",
  stuck: "The sign-in was not confirmed. Check the page before you do anything else.",
  failed: "The sign-in could not be delivered to the lane's browser.",
} as const;

type Outcome = keyof typeof SAID;

const isOutcome = (value: string | undefined): value is Outcome =>
  value !== undefined && Object.hasOwn(SAID, value);

type Envelope = OpResult<"signin.redeem">;

function deliver(envelope: Envelope): Promise<Outcome> {
  return new Promise((settle) => {
    const child = spawn("fleet-browser", ["login", "--lane", envelope.lane, "--stdin"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, BROWSER_DEADLINE_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (out.length < MAX_OUTPUT) out += chunk;
    });
    child.stdin.on("error", () => 0);
    child.once("error", () => {
      clearTimeout(timer);
      settle("failed");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const said = OUTCOME.exec(out)?.[1];
      settle(code === 0 && isOutcome(said) ? said : "failed");
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

export function registerBrowserSignin(pi: ExtensionAPI, link: Link): void {
  pi.registerTool({
    name: "browser_signin",
    label: "Browser sign-in",
    description:
      "Signs your lane's browser in to a site with a password the captain granted, without showing it to you. The captain's card comment gives the grant, the entry and the sign-in URL: open that exact URL with fleet-browser first, then call this with the three values. The grant works once, for this lane, that entry and that URL only. You get a fixed outcome, never the password. If the sign-in fails the grant is spent: report blocked and ask for a new one. Never look for the password yourself or type one into a page.",
    parameters: OPS["signin.redeem"].args,
    execute: async (_id, params) => {
      const envelope = await link.call("signin.redeem", params, REDEEM_DEADLINE_MS);
      const outcome = await deliver(envelope);
      const text = `browser_signin ${outcome}. ${SAID[outcome]}${outcome === "done" ? "" : " The grant is spent."}`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
