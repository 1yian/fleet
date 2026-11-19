import { AxiError } from "axi-sdk-js";
import { daemon } from "./client.js";
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

export async function loginCommand(lane: string, args: string[]) {
  const item = need(args[0], "Run `fleet-browser login <item>` where <item> is the vault item name");
  const result = await daemon.post<LoginResult>(lane, "login", { item });
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
  const status = await daemon.get<{ ratelimit: string; localReadsLast24h: number; localDailyBudget: number }>(
    lane,
    "broker-status",
  );
  return {
    local_reads_24h: `${status.localReadsLast24h} of ${status.localDailyBudget}`,
    ratelimit: status.ratelimit.split("\n"),
  };
}
