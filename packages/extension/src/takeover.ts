import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dial } from "@fleet/protocol/tunnel";
import { hold, tabsOf, through } from "./takeover-host.ts";
import { launchChrome } from "./takeover-mac.ts";
import type { Page } from "./takeover-page.ts";
import { Takeover } from "./takeover-run.ts";
import { counts } from "./takeover-session.ts";
import { openSocks } from "./takeover-tunnel.ts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";

const USAGE = `usage:
  fleet-chrome list --host <host> [--endpoint <url>]
  fleet-chrome take <tab> --host <host> [--lane <name>] [--also <url>]... [--endpoint <url>]

<host> is an ssh name that reaches the host of the shared Chrome with no prompt.
<tab> is a number from list, the start of a tab id, or text of its address or title.
--lane names the Mac profile (one per lane). --also adds another address whose cookies go with the session.`;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Options {
  readonly command: "list" | "take";
  readonly host: string;
  readonly endpoint: string;
  readonly lane: string;
  readonly also: readonly string[];
  readonly tab: string | undefined;
}

function parse(argv: readonly string[]): Options {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      host: { type: "string" },
      endpoint: { type: "string" },
      lane: { type: "string" },
      also: { type: "string", multiple: true },
    },
  });
  if ((command !== "list" && command !== "take") || (values.host ?? "") === "")
    throw new Error(USAGE);
  return {
    command,
    host: values.host ?? "",
    endpoint: values.endpoint ?? DEFAULT_ENDPOINT,
    lane: values.lane ?? "default",
    also: values.also ?? [],
    tab: positionals[0],
  };
}

const listing = (tabs: readonly Page[]): string =>
  tabs
    .map(
      (tab, at) =>
        `${String(at + 1)}  ${tab.id.slice(0, 8)}  ${tab.title || "(no title)"}  ${tab.url}`,
    )
    .join("\n");

function choose(tabs: readonly Page[], wanted: string | undefined): Page {
  if (tabs.length === 0) throw new Error("the host's Chrome has no web page open");
  if (wanted === undefined) throw new Error(`name the tab to take:\n${listing(tabs)}`);
  const numbered = /^\d+$/.test(wanted) ? tabs[Number(wanted) - 1] : undefined;
  const found =
    numbered === undefined
      ? tabs.filter(
          (tab) =>
            tab.id.startsWith(wanted) || tab.url.includes(wanted) || tab.title.includes(wanted),
        )
      : [numbered];
  const [only] = found;
  if (found.length === 1 && only !== undefined) return only;
  const which = found.length === 0 ? "no tab matches" : "more than one tab matches";
  throw new Error(`${which} "${wanted}":\n${listing(found.length === 0 ? tabs : found)}`);
}

async function list(options: Options): Promise<void> {
  const via = dial(["ssh", options.host], options.endpoint);
  try {
    console.log(listing(await through(via, tabsOf)));
  } finally {
    via.close();
  }
}

async function take(options: Options): Promise<void> {
  const via = dial(["ssh", options.host], options.endpoint);
  const socks = await openSocks(options.host).catch((error: unknown) => {
    via.close();
    throw error;
  });
  try {
    const tab = choose(await through(via, tabsOf), options.tab);
    const held = await through(via, (cdp) => hold(cdp, tab, options.also));
    console.log(`Holding ${tab.title || tab.url} (${held.origin}): ${counts(held)}.`);
    const home = process.env["FLEET_CHROME_HOME"] ?? join(homedir(), ".fleet-chrome");
    const profile = join(home, options.lane, "profile");
    const chrome = await launchChrome({ profile, socks: socks.port });
    console.log(`Chrome debugging port: ${String(chrome.port)} (loopback only)`);
    await new Takeover({
      chrome,
      held,
      tab,
      via,
      host: options.host,
      profile,
      tunnelEnded: socks.ended,
    }).run();
  } finally {
    socks.close();
    via.close();
  }
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.command === "list") await list(options);
  else await take(options);
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error(reason(error));
    process.exit(1);
  },
);
