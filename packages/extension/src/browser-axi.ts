import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { encode } from "@toon-format/toon";
import { check, HttpOutcomeSchema, OPS, type BrowserArgs, type OpResult } from "@fleet/protocol";
import {
  callUrl,
  resolveSource,
  sourceFromEnv,
  type Access,
  type Source,
} from "./browser-access.ts";
import { placeViewer, removeViewer } from "./browser-place.ts";

const EXIT = { ok: 0, error: 1, usage: 2, notFound: 3, noBrowser: 4 } as const;

const USAGE = `browser-axi: drive your card's tab in the fleet's shared Chrome
  browser-axi                          show whether the fleet has a shared browser and your tab
  browser-axi open <url>               give your card its own tab and load url (or load another url in it)
  browser-axi back | forward           go one page back or forward in your tab's history
  browser-axi reload                   load your tab's current page again
  browser-axi read [--selector css] [--html]
  browser-axi click --selector css | --x n --y n
  browser-axi type --text <text> [--selector css] [--submit]
  browser-axi press <key>              Enter, Tab, Escape, Backspace, ArrowDown ...
  browser-axi eval <javascript expression>
  browser-axi screenshot [--full-page] [--out file]
  browser-axi login [--site host]      fill the username and password of the site your tab shows from the fleet's Bitwarden Logins project; you never see them
  browser-axi close                    close your tab
flags for every command:
  --card <n>        a mate names the card whose tab it drives (a worker never needs it)
  --captain <why>   the captain is needed in this tab (passkey, one-time code, terms, payment): the viewer opens in your lane's workspace if the captain is there, and in main's if he is not
  --json            print one JSON object instead of TOON
exit status: 0 done, 1 error, 2 usage, 3 login found no entry (the mate was asked), 4 this fleet has no shared browser`;

const OPTIONS = {
  card: { type: "string" },
  captain: { type: "string" },
  json: { type: "boolean" },
  selector: { type: "string" },
  html: { type: "boolean" },
  x: { type: "string" },
  y: { type: "string" },
  text: { type: "string" },
  submit: { type: "boolean" },
  "full-page": { type: "boolean" },
  out: { type: "string" },
  site: { type: "string" },
  help: { type: "boolean" },
} as const;

class Usage extends Error {}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Values = ReturnType<typeof parse>["values"];

function parse(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new Usage(reason(error));
  }
}

const count = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Usage(`--${name} wants a number`);
  return number;
};

function withOnly<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}

type Builder = (rest: readonly string[], values: Values) => BrowserArgs;

const wanted = (value: string | undefined, message: string): string => {
  if (value === undefined) throw new Usage(message);
  return value;
};

const BUILDERS: Record<string, Builder> = {
  open: ([url]) => ({
    action: "open",
    url: wanted(url, "open wants a url: browser-axi open <url>"),
  }),
  read: (_, values) => ({
    action: "read",
    ...withOnly("selector", values.selector),
    ...(values.html === true ? { html: true } : {}),
  }),
  click: (_, values) => {
    const x = count(values.x, "x");
    const y = count(values.y, "y");
    if (values.selector === undefined && (x === undefined || y === undefined))
      throw new Usage(
        "click wants --selector <css>, or --x <n> --y <n>: browser-axi click --selector a",
      );
    return {
      action: "click",
      ...withOnly("selector", values.selector),
      ...withOnly("x", x),
      ...withOnly("y", y),
    };
  },
  type: ([first], values) => ({
    action: "type",
    text: wanted(values.text ?? first, "type wants --text <text>"),
    ...withOnly("selector", values.selector),
    ...(values.submit === true ? { submit: true } : {}),
  }),
  press: ([key]) => ({
    action: "press",
    key: wanted(key, "press wants a key: browser-axi press Enter"),
  }),
  eval: ([expression]) => ({
    action: "eval",
    expression: wanted(expression, "eval wants an expression: browser-axi eval <javascript>"),
  }),
  screenshot: (_, values) => ({
    action: "screenshot",
    ...(values["full-page"] === true ? { fullPage: true } : {}),
  }),
  login: (_, values) => ({ action: "login", ...withOnly("site", values.site) }),
  back: () => ({ action: "back" }),
  forward: () => ({ action: "forward" }),
  reload: () => ({ action: "reload" }),
  close: () => ({ action: "close" }),
};

function argsFor(command: string, rest: readonly string[], values: Values): BrowserArgs {
  const build = BUILDERS[command];
  if (build === undefined) throw new Usage(`unknown command ${command}`);
  return {
    ...build(rest, values),
    ...withOnly("card", count(values.card, "card")),
    ...withOnly("captain", values.captain),
  };
}

async function call(
  access: Access,
  op: "browser" | "browser.view",
  args: object,
): Promise<unknown> {
  const named = access.host === undefined ? {} : { host: access.host };
  const response = await fetch(callUrl(access.url), {
    method: "POST",
    headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
    body: JSON.stringify({ op, args: { ...args, ...named } }),
    signal: AbortSignal.timeout(120_000),
  }).catch((error: unknown) => {
    throw new Error(`cardd is unreachable (${reason(error)})`);
  });
  const outcome = check(HttpOutcomeSchema, await response.json().catch(() => ({})));
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.value;
}

const SHOT_DIR = "fleet-shot-";
const SHOT_KEEP_MS = 24 * 60 * 60 * 1000;

function sweepOldShots(): void {
  try {
    const root = tmpdir();
    const oldest = Date.now() - SHOT_KEEP_MS;
    for (const name of readdirSync(root).filter((each) => each.startsWith(SHOT_DIR))) {
      const path = join(root, name);
      const found = lstatSync(path);
      if (found.isDirectory() && found.uid === process.getuid?.() && found.mtimeMs < oldest)
        rmSync(path, { recursive: true, force: true });
    }
  } catch {
    return;
  }
}

function shotDirectory(): string {
  sweepOldShots();
  return mkdtempSync(join(tmpdir(), SHOT_DIR));
}

function saveImage(image: { mimeType: string; data: string }, out: string | undefined): string {
  const extension = image.mimeType.includes("jpeg") ? "jpg" : "png";
  const file = out === undefined ? join(shotDirectory(), `screenshot.${extension}`) : resolve(out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
  return file;
}

async function place(source: Source, why: string | undefined): Promise<string> {
  if (why !== undefined)
    return `the captain is needed (${why}): the Browser tab opens in your lane's workspace if the captain is there, and otherwise in main's workspace`;
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace === undefined)
    return "no herdr workspace in this shell, so no viewer tab was opened";
  try {
    const placed = await placeViewer({
      workspace,
      cwd: process.cwd(),
      source,
      open: false,
      focus: false,
      captain: false,
    });
    return placed.started
      ? "a Browser tab in your own workspace shows your tab live"
      : "the Browser tab in your own workspace already shows your tab";
  } catch (error) {
    return `no viewer tab was opened in your workspace (${reason(error)})`;
  }
}

function valueOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function unplace(access: Access): Promise<string | undefined> {
  const workspace = process.env["HERDR_WORKSPACE_ID"];
  if (workspace === undefined) return undefined;
  try {
    const view = check(OPS["browser.view"].result, await call(access, "browser.view", {}));
    if (view.tabs.length > 0 || !(await removeViewer(workspace))) return undefined;
    return "the Browser tab in your own workspace is closed, since no tab is left to show";
  } catch (error) {
    return `the Browser tab in your own workspace was not closed (${reason(error)})`;
  }
}

const HELP: Record<string, readonly string[]> = {
  open: [
    "Run `browser-axi read` for the page's text, `browser-axi screenshot` for a picture, `browser-axi click --selector <css>` to act",
    "Run `browser-axi login` on a login page: the fleet fills the username and password and you never see them",
    "Run `browser-axi open <url> --captain <why>` or add --captain <why> to any command when a passkey, a one-time code, terms or a payment needs the captain",
  ],
  back: ["Run `browser-axi read` for the page's text, or `browser-axi forward` to return"],
  forward: ["Run `browser-axi read` for the page's text, or `browser-axi back` to return"],
  reload: ["Run `browser-axi read` for the page's text"],
  screenshot: ["Look at the picture file named in `image` with your image tools"],
  login: [
    "Run `browser-axi click --selector <css>` on the sign-in button, then `browser-axi read`",
    "Never ask for, type, store, or report a password, a code, or a token",
  ],
};

const MORE = "Run `browser-axi --help` for every command";
const OPEN_URL = "Run `browser-axi open <url>` to load a page in your tab";
const OPEN_TAB = "Run `browser-axi open <url>` to open your tab";
const USE_TAB =
  "Run `browser-axi read` for the page's text, `browser-axi screenshot` for a picture, or `browser-axi close` when you are done with your tab";
const NO_LOGINS = [
  "Tell your mate that logins are not set up on this host, and report paused or blocked until they are",
  "Never ask for, type, store, or report a password, a code, or a token",
];

const NOT_FOUND = [
  "The fleet asked your mate to have the login added. Wait for the captain (report paused or blocked until it is), then run `browser-axi login` again",
];
const NO_BROWSER = [
  "Do not retry. Nothing changed for you: carry on with the tools you used before, and tell your mate if the task cannot be done without the shared browser",
];

interface Printed {
  readonly record: Record<string, unknown>;
  readonly help: readonly string[];
  readonly code: number;
  readonly raw?: string;
}

const helpBlock = (help: readonly string[]): string =>
  help.length === 0
    ? ""
    : `\nhelp[${String(help.length)}]:\n${help.map((line) => `  ${line}`).join("\n")}`;

function render({ record, help, raw }: Printed, json: boolean): string {
  if (raw !== undefined) return raw;
  return json ? JSON.stringify({ ...record, help }) : encode(record) + helpBlock(help);
}

function emit(printed: Printed, json: boolean): void {
  process.stdout.write(`${render(printed, json)}\n`, () => {
    process.exit(printed.code);
  });
}

function failure(error: unknown): Printed {
  const message = reason(error);
  if (error instanceof Usage) return { record: { error: message }, help: [MORE], code: EXIT.usage };
  if (message.includes("no shared browser configured"))
    return {
      record: { error: `no shared browser: ${message}` },
      help: NO_BROWSER,
      code: EXIT.noBrowser,
    };
  if (message.includes("`browser-axi open <url>`"))
    return { record: { error: message }, help: [OPEN_URL, MORE], code: EXIT.error };
  if (message.startsWith("logins are not set up on "))
    return { record: { error: message }, help: NO_LOGINS, code: EXIT.error };
  return { record: { error: message }, help: [], code: EXIT.error };
}

interface Caller {
  readonly source: Source;
  readonly access: Access;
}

async function state({ access }: Caller, values: Values): Promise<Printed> {
  const card = count(values.card, "card");
  const view = check(
    OPS["browser.view"].result,
    await call(access, "browser.view", card === undefined ? {} : { card }),
  );
  if (view.browsers.length === 0)
    throw new Error(
      "this fleet has no shared browser configured: cardd was started without --browser",
    );
  if (view.host !== null && !view.browsers.some(({ host }) => host === view.host))
    throw new Error(
      `this fleet has no shared browser configured on host ${view.host}: cardd's --browser names ${view.browsers.map(({ host }) => host).join(", ")}`,
    );
  const tabs = view.tabs.map((tab) => tab.label);
  return {
    record: {
      browser: "configured",
      ...(view.host === null ? {} : { host: view.host }),
      tabs: tabs.length === 0 ? "none open" : tabs,
    },
    help: [tabs.length === 0 ? OPEN_TAB : USE_TAB, MORE],
    code: EXIT.ok,
  };
}

async function viewerNote(
  { source, access }: Caller,
  command: string,
  captain: string | undefined,
): Promise<string | undefined> {
  if (captain !== undefined || command === "open") return place(source, captain);
  return command === "close" ? unplace(access) : undefined;
}

async function act(
  caller: Caller,
  command: string,
  rest: readonly string[],
  values: Values,
): Promise<Printed> {
  const args = argsFor(command, rest, values);
  const result: OpResult<"browser"> = check(
    OPS.browser.result,
    await call(caller.access, "browser", args),
  );
  const record: Record<string, unknown> = { action: command };
  if (result.page !== undefined) record["page"] = result.page;
  record["result"] = command === "eval" ? valueOf(result.text) : result.text;
  if (result.image !== undefined) record["image"] = saveImage(result.image, values.out);
  const view = await viewerNote(caller, command, result.captain);
  if (view !== undefined) record["view"] = view;
  const notFound = result.text.startsWith("not found:");
  return {
    record,
    help: notFound ? NOT_FOUND : (HELP[command] ?? []),
    code: notFound ? EXIT.notFound : EXIT.ok,
  };
}

async function run(): Promise<Printed> {
  const { values, positionals } = parse(process.argv.slice(2));
  if (values.help === true) return { record: {}, help: [], raw: USAGE, code: EXIT.ok };
  const source = sourceFromEnv(process.env);
  if (source === undefined)
    throw new Error(
      "no fleet credentials in this shell: run browser-axi from a fleet agent's shell (FLEET_BROWSER_URL and FLEET_BROWSER_TOKEN, or FLEET_BROWSER_HOME)",
    );
  const caller = { source, access: await resolveSource(source) };
  const [command, ...rest] = positionals;
  return command === undefined ? state(caller, values) : act(caller, command, rest, values);
}

const json = process.argv.includes("--json");
run().then(
  (printed) => {
    emit(printed, json);
  },
  (error: unknown) => {
    emit(failure(error), json);
  },
);
