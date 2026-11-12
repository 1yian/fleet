import { record, words } from "./wire.ts";

const ALLOWED_DOMAINS = new Set([
  "Input",
  "Target",
  "Emulation",
  "Inspector",
  "Log",
  "Browser",
  "Network",
  "Fetch",
  "Security",
  "Schema",
]);

const ALLOWED_METHODS = new Set([
  "Page.enable",
  "Page.disable",
  "Page.navigate",
  "Page.reload",
  "Page.stopLoading",
  "Page.bringToFront",
  "Page.close",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.getFrameTree",
  "Page.setLifecycleEventsEnabled",
  "Page.handleJavaScriptDialog",
  "Runtime.enable",
  "Runtime.disable",
  "Runtime.runIfWaitingForDebugger",
  "Runtime.discardConsoleEntries",
  "Runtime.addBinding",
  "Runtime.removeBinding",
]);

const REFUSED_ALWAYS = new Set([
  "Target.sendMessageToTarget",
  "Target.exposeDevToolsProtocol",
  "Network.replayXHR",
]);

const DROPPED_DOMAINS = new Set([
  "DOM",
  "DOMDebugger",
  "CSS",
  "Debugger",
  "Overlay",
  "Accessibility",
]);

const DROPPED_EVENTS = new Set([
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Runtime.bindingCalled",
  "Page.screencastFrame",
  "Network.webSocketFrameSent",
  "Network.webSocketFrameReceived",
  "Network.eventSourceMessageReceived",
]);

type Scope = "net" | "fetch" | "icpt";
type IdField = readonly [string, Scope];

const REQUEST_FIELDS = new Map<string, readonly IdField[]>([
  ["Network.requestWillBeSent", [["requestId", "net"]]],
  [
    "Network.requestIntercepted",
    [
      ["interceptionId", "icpt"],
      ["requestId", "net"],
    ],
  ],
  [
    "Fetch.requestPaused",
    [
      ["requestId", "fetch"],
      ["networkId", "net"],
    ],
  ],
]);

const BODY_READERS = new Map<string, IdField>([
  ["Network.getRequestPostData", ["requestId", "net"]],
  ["Network.getResponseBody", ["requestId", "net"]],
  ["Network.searchInResponseBody", ["requestId", "net"]],
  ["Network.streamResourceContent", ["requestId", "net"]],
  ["Network.getResponseBodyForInterception", ["interceptionId", "icpt"]],
  ["Network.takeResponseBodyForInterceptionAsStream", ["interceptionId", "icpt"]],
  ["Fetch.getResponseBody", ["requestId", "fetch"]],
  ["Fetch.takeResponseBodyAsStream", ["requestId", "fetch"]],
]);

const keyOf = (scope: Scope, id: string, session: string): string =>
  scope === "net" ? `net:${id}` : `${scope}:${session}:${id}`;

const domainOf = (method: string): string => method.slice(0, method.indexOf("."));

const runsScript = (params: unknown): boolean =>
  /^\s*javascript:/i.test(words(record(params), "url") ?? "");

export function refusedAlways(method: string): boolean {
  return REFUSED_ALWAYS.has(method);
}

const POST_FIRST = "post:";

export function readerKeys(method: string, params: unknown, session: string): string[] {
  const field = BODY_READERS.get(method);
  if (field === undefined) return [];
  const key = keyOf(field[1], words(record(params), field[0]) ?? "", session);
  return method === "Network.getRequestPostData" ? [key, `${POST_FIRST}${key}`] : [key];
}

function documentPost(method: string, params: unknown): boolean {
  const fields = record(params);
  const type =
    method === "Network.requestWillBeSent" ? words(fields, "type") : words(fields, "resourceType");
  if (type !== "Document" || !REQUEST_FIELDS.has(method)) return false;
  const verb = words(record(fields?.["request"]), "method");
  return verb !== undefined && verb !== "GET";
}

export function postKeys(method: string, params: unknown, session: string): string[] {
  return documentPost(method, params)
    ? requestKeys(method, params, session)
        .filter((key) => key.startsWith("net:"))
        .map((key) => `${POST_FIRST}${key}`)
    : [];
}

export function requestKeys(method: string, params: unknown, session: string): string[] {
  const fields = record(params);
  return (REQUEST_FIELDS.get(method) ?? []).flatMap(([field, scope]) => {
    const id = words(fields, field);
    return id === undefined ? [] : [keyOf(scope, id, session)];
  });
}

export function allowedWhileTyped(method: string, params: unknown): boolean {
  if (BODY_READERS.has(method)) return false;
  if ((method === "Page.navigate" || method === "Target.createTarget") && runsScript(params))
    return false;
  return ALLOWED_DOMAINS.has(domainOf(method)) || ALLOWED_METHODS.has(method);
}

export function droppedWhileTyped(method: string): boolean {
  return DROPPED_EVENTS.has(method) || DROPPED_DOMAINS.has(domainOf(method));
}

const BODY_FIELDS = new Set(["postData", "postDataEntries"]);

export function withoutBody(method: string, params: unknown): Record<string, unknown> | undefined {
  if (!REQUEST_FIELDS.has(method)) return undefined;
  const fields = record(params);
  const request = record(fields?.["request"]);
  if (fields === undefined || request === undefined) return undefined;
  const rest = Object.fromEntries(Object.entries(request).filter(([key]) => !BODY_FIELDS.has(key)));
  return { ...fields, request: rest };
}
