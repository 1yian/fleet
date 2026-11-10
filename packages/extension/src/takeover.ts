import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dial, type Dial } from "@fleet/protocol/tunnel";
import { hold, tabsOf, through } from "./takeover-host.ts";
import { interruption, whenAborted } from "./takeover-interrupt.ts";
import { lockLane } from "./takeover-lock.ts";
import { launchChrome } from "./takeover-mac.ts";
import type { Page } from "./takeover-page.ts";
import { Takeover } from "./takeover-run.ts";
import { counts } from "./takeover-session.ts";
import { openSocks } from "./takeover-tunnel.ts";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222";

const USAGE = `usage:
  fleet-chrome list --host <host> [--endpoint <url>]
  fleet-chrome take <tab> --host <host> [--lane <name>] [--endpoint <url>]

<host> is an ssh name that reaches the host of the shared Chrome with no prompt.
<tab> is the number that list prints.
--lane names the Mac profile (one per lane).`;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Options {
  readonly command: "list" | "take";
  readonly host: string;
  readonly endpoint: string;
  readonly lane: string;
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
    },
  });
  if ((command !== "list" && command !== "take") || (values.host ?? "") === "")
    throw new Error(USAGE);
  return {
    command,
    host: values.host ?? "",
    endpoint: values.endpoint ?? DEFAULT_ENDPOINT,
    lane: values.lane ?? "default",
    tab: positionals[0],
  };
}

const listing = (tabs: readonly Page[]): string =>
  tabs.map((tab, at) => `${String(at + 1)}  ${tab.title || "(no title)"}  ${tab.url}`).join("\n");

function choose(tabs: readonly Page[], wanted: string | undefined): Page {
  if (tabs.length === 0) throw new Error("the host's Chrome has no web page open");
  if (wanted === undefined) throw new Error(`name the tab to take:\n${listing(tabs)}`);
  const found = /^\d+$/.test(wanted) ? tabs[Number(wanted) - 1] : undefined;
  if (found === undefined) throw new Error(`no tab matches "${wanted}":\n${listing(tabs)}`);
  return found;
}

async function list(options: Options): Promise<void> {
  const via = dial(["ssh", options.host], options.endpoint);
  try {
    console.log(listing(await through(via, tabsOf)));
  } finally {
    via.close();
  }
}

async function takeOver(
  options: Options,
  profile: string,
  via: Dial,
  signal: AbortSignal,
): Promise<void> {
  const socks = await openSocks(options.host, signal);
  try {
    const unwatch = whenAborted(signal, () => {
      via.close();
    });
    const tab = choose(await through(via, tabsOf), options.tab);
    const held = await through(via, (cdp) => hold(cdp, tab));
    unwatch();
    signal.throwIfAborted();
    console.log(`Holding ${tab.title || tab.url} (${held.origin}): ${counts(held)}.`);
    const chrome = await launchChrome({ profile, socks: socks.port }, signal);
    console.log(`Chrome debugging port: ${String(chrome.port)} (loopback only)`);
    await new Takeover({
      chrome,
      held,
      tab,
      via,
      host: options.host,
      profile,
      tunnelEnded: socks.ended,
      signal,
    }).run();
  } finally {
    socks.close();
  }
}

async function take(options: Options): Promise<void> {
  const home = process.env["FLEET_CHROME_HOME"] ?? join(homedir(), ".fleet-chrome");
  const folder = join(home, options.lane);
  const via = dial(["ssh", options.host], options.endpoint);
  const lock = lockLane(folder, options.lane);
  const interrupt = interruption();
  try {
    await takeOver(options, join(folder, "profile"), via, interrupt.signal);
  } catch (error) {
    throw interrupt.signal.aborted ? new Error("interrupted") : error;
  } finally {
    via.close();
    interrupt.release();
    lock.release();
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
