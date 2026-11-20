import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, parseRecord } from "./json.ts";

interface Page {
  readonly id: number;
  readonly url: string;
}

interface Bridge {
  readonly next: number;
  readonly pages: readonly Page[];
}

const DEFAULT_SESSION = "default";
const LOCK_POLL_MS = 5;

class Refused extends Error {}

function fail(message: string): never {
  throw new Refused(message);
}

const base = process.env["FAKE_BROWSER_ROOT"];
if (base === undefined) fail("FAKE_BROWSER_ROOT is not set");
const asked = (process.env["CHROME_DEVTOOLS_AXI_SESSION"] ?? "").trim();
const session = asked === "" ? DEFAULT_SESSION : asked;
if (!/^[A-Za-z0-9._-]{1,64}$/.test(session) || /^\.+$/.test(session))
  fail(`Invalid CHROME_DEVTOOLS_AXI_SESSION "${session}"`);
const state = session === DEFAULT_SESSION ? base : join(base, "sessions", session);
mkdirSync(state, { recursive: true });
const bridgeFile = join(state, "bridge.json");
const selectedFile = join(state, "selected-page-id");

function locked<T>(run: () => T): T {
  const lock = join(state, "lock");
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return run();
  } finally {
    rmSync(lock, { recursive: true });
  }
}

function readBridge(): Bridge {
  let text: string;
  try {
    text = readFileSync(bridgeFile, "utf8");
  } catch {
    return { next: 1, pages: [] };
  }
  const record = parseRecord(text);
  const pages = Array.isArray(record["pages"]) ? record["pages"].filter(isRecord) : [];
  return {
    next: Number(record["next"]),
    pages: pages.map((page) => ({ id: Number(page["id"]), url: String(page["url"]) })),
  };
}

function writeBridge(bridge: Bridge): void {
  writeFileSync(bridgeFile, JSON.stringify(bridge));
}

function selected(): number | undefined {
  try {
    return Number(readFileSync(selectedFile, "utf8"));
  } catch {
    return undefined;
  }
}

function select(id: number): void {
  writeFileSync(selectedFile, String(id));
}

function deselect(): void {
  try {
    unlinkSync(selectedFile);
  } catch {
    return;
  }
}

function openPage(url: string): Page {
  const bridge = readBridge();
  const page = { id: bridge.next, url };
  writeBridge({ next: bridge.next + 1, pages: [...bridge.pages, page] });
  select(page.id);
  return page;
}

function selectedPage(): Page {
  const id = selected();
  const page = readBridge().pages.find((each) => each.id === id);
  if (page === undefined) fail("no page is selected, run `newpage <url>` or `selectpage <id>`");
  return page;
}

const [command, ...args] = process.argv.slice(2);
const operands = args.filter((arg) => !arg.startsWith("--"));

function openUrl(url: string): string {
  if (selected() === undefined) return `page: {id: ${String(openPage(url).id)}, url: ${url}}`;
  const current = selectedPage();
  const bridge = readBridge();
  writeBridge({
    next: bridge.next,
    pages: bridge.pages.map((page) => (page.id === current.id ? { id: page.id, url } : page)),
  });
  return `page: {id: ${String(current.id)}, url: ${url}}`;
}

function listPages(): string {
  const current = selected();
  return readBridge()
    .pages.map(
      (page) => `${String(page.id)}\t${page.url}\t${page.id === current ? "selected" : "-"}`,
    )
    .join("\n");
}

function closePage(operand: string | undefined): string {
  const id = Number(operand);
  const bridge = readBridge();
  if (!bridge.pages.some((page) => page.id === id)) fail(`no page ${String(operand)}`);
  writeBridge({ next: bridge.next, pages: bridge.pages.filter((page) => page.id !== id) });
  if (selected() === id) deselect();
  return `closed: ${String(id)}`;
}

function run(): string {
  switch (String(command)) {
    case "newpage": {
      const page = openPage(operands[0] ?? fail("newpage needs a url"));
      return `page: {id: ${String(page.id)}, url: ${page.url}}`;
    }
    case "open":
      return openUrl(operands[0] ?? fail("open needs a url"));
    case "eval":
      if (operands[0] !== "location.href") fail(`eval only answers location.href`);
      return selectedPage().url;
    case "pages":
      return listPages();
    case "closepage":
      return closePage(operands[0]);
    default:
      return fail(`unknown command ${String(command)}`);
  }
}

try {
  const output = locked(run);
  if (output !== "") console.log(output);
} catch (error) {
  if (!(error instanceof Refused)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
