import { AxiError } from "axi-sdk-js";
import { DIRECT_LOGIN_LIMIT, parseDirectLogin } from "../shared/direct-login.js";
import { ownTab } from "./browser.js";
import { daemon, postDirectLogin } from "./client.js";
import { parseDuration } from "./duration.js";

interface LoginResult {
  outcome: string;
  steps: string[];
  url: string;
  title: string;
  hints: string[];
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
}

function need(item: string | undefined, usage: string): string {
  if (!item) throw new AxiError("an item name is required", "NO_ITEM", [usage]);
  return item;
}

const NEXT: Record<string, string> = {
  done: "No login fields are left; run `fleet-browser snapshot -i` to confirm you are signed in",
  stuck:
    'Login fields are still visible; check the hints, run `fleet-browser snapshot -i`, or `fleet-browser handoff "<what the captain should do>"`',
  "no-form": "No login form was found; open the sign-in page first with `fleet-browser open <url>`",
  "off-origin":
    "The page left the sites this item is bound to, so nothing more was typed; check the page with `fleet-browser snapshot -i` or hand off",
  "needs-otp":
    "The site asks for a one-time code and the item has no one-time password field; use `fleet-browser mail code <item>` or hand off",
};

async function directLoginCommand(lane: string, args: string[]) {
  const invalid = () =>
    new AxiError(
      "provide a bounded JSON credential envelope on piped stdin, never in arguments",
      "BAD_DIRECT_LOGIN",
    );
  if (args.length !== 1 || process.stdin.isTTY) throw invalid();
  const chunks: Buffer[] = [];
  let size = 0;
  let delivery: ReturnType<typeof parseDirectLogin>;
  try {
    for await (const chunk of process.stdin) {
      size += (chunk as Buffer).length;
      if (size > DIRECT_LOGIN_LIMIT) throw invalid();
      chunks.push(chunk as Buffer);
    }
    delivery = parseDirectLogin(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw invalid();
  }
  if (!delivery) throw invalid();
  if (delivery.lane !== lane)
    throw new AxiError("credential lane does not match the selected lane", "DIRECT_LOGIN_WRONG_LANE");
  const result = await postDirectLogin<{ outcome: string }>(delivery);
  switch (result.outcome) {
    case "done":
      return { login: "done", help: [NEXT.done] };
    case "no-form":
      return { login: "no-form", help: ["Open a same-origin POST sign-in form with a password field"] };
    case "off-origin":
      return {
        login: "off-origin",
        help: ["The page does not match the credential's exact origin; nothing was typed"],
      };
    case "stuck":
      return { login: "stuck", help: ["Sign-in was not confirmed; check the page before retrying"] };
    default:
      throw new AxiError("direct login did not return a result", "DIRECT_LOGIN_FAILED");
  }
}

export async function loginCommand(lane: string, args: string[]) {
  if (args[0] === "--stdin") return directLoginCommand(lane, args);
  const item = need(args[0], "Run `fleet-browser login <item>` where <item> is the vault item name");
  const result = await daemon.post<LoginResult>(lane, "login", { item, target: await ownTab(lane) });
  return {
    login: result.outcome,
    steps: result.steps.join(", ") || "none",
    page: { title: result.title, url: result.url },
    ...(result.hints.length ? { page_says: result.hints.join(", ") } : {}),
    help: [NEXT[result.outcome] ?? "Run `fleet-browser snapshot -i`"],
  };
}

export async function otpCommand(lane: string, args: string[]) {
  const rest = [...args];
  const submit = rest.includes("--submit");
  const item = need(
    rest.find((a) => !a.startsWith("--")),
    "Run `fleet-browser otp <item> [--submit]`",
  );
  const result = await daemon.post<{ typed: boolean; url: string; title: string }>(lane, "otp", {
    item,
    submit,
    target: await ownTab(lane),
  });
  return {
    otp: submit ? "typed and submitted" : "typed",
    page: { title: result.title, url: result.url },
    help: ["Run `fleet-browser snapshot -i` to see the result"],
  };
}

export async function mailCommand(lane: string, args: string[]) {
  const rest = [...args];
  const kind = rest.shift();
  if (kind !== "link" && kind !== "code") {
    throw new AxiError("mail needs link or code", "BAD_MAIL_KIND", [
      "Run `fleet-browser mail link <item> --match <text>`",
      "Run `fleet-browser mail code <item> --match <text>`",
    ]);
  }
  const submit = rest.includes("--submit");
  if (submit) rest.splice(rest.indexOf("--submit"), 1);
  const match = flag(rest, "--match");
  const pattern = flag(rest, "--pattern");
  const since = flag(rest, "--since");
  const wait = flag(rest, "--wait");
  const item = need(
    rest[0],
    "Run `fleet-browser mail link|code <item> [--match <regex>] [--since 10m] [--wait 60s] [--submit]`",
  );
  const result = await daemon.post<{
    subject: string;
    from: string;
    opened?: string;
    typed?: boolean;
    url: string;
    title: string;
  }>(lane, "mail", {
    item,
    kind,
    match,
    pattern,
    sinceSeconds: since ? parseDuration(since) : 600,
    waitSeconds: wait ? parseDuration(wait) : 0,
    submit,
    target: await ownTab(lane),
  });
  return {
    mail:
      kind === "link"
        ? `opened a link on ${result.opened}`
        : submit
          ? "typed the code into the field and pressed Enter"
          : "typed the code into the field",
    message: { subject: result.subject, from: result.from },
    page: { title: result.title, url: result.url },
    help: ["Run `fleet-browser snapshot -i` to see the page"],
  };
}

export async function brokerStatus(lane: string) {
  const status = await daemon.get<{
    ratelimit: string;
    localReadsLast24h: number;
    localDailyBudget: number;
    vaults: Record<string, string>;
  }>(lane, "broker-status");
  return {
    vault: status.vaults[lane] ?? "lane not set up in the broker",
    local_reads_24h: `${status.localReadsLast24h} of ${status.localDailyBudget}`,
    ratelimit: status.ratelimit.split("\n"),
  };
}
