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

const REFUSED_ALWAYS = new Set(["Target.sendMessageToTarget", "Target.exposeDevToolsProtocol"]);

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

const BODY_EVENTS = new Set([
  "Network.requestWillBeSent",
  "Network.requestIntercepted",
  "Fetch.requestPaused",
]);

const BODY_READERS = new Map([
  ["Network.getRequestPostData", "requestId"],
  ["Network.getResponseBody", "requestId"],
  ["Network.searchInResponseBody", "requestId"],
  ["Network.streamResourceContent", "requestId"],
  ["Network.getResponseBodyForInterception", "interceptionId"],
  ["Fetch.getResponseBody", "requestId"],
  ["Fetch.takeResponseBodyAsStream", "requestId"],
]);

const domainOf = (method: string): string => method.slice(0, method.indexOf("."));

const runsScript = (params: unknown): boolean =>
  /^\s*javascript:/i.test(words(record(params), "url") ?? "");

export function refusedAlways(method: string): boolean {
  return REFUSED_ALWAYS.has(method);
}

export function bodyReaderOf(method: string, params: unknown): string | undefined {
  const key = BODY_READERS.get(method);
  return key === undefined ? undefined : (words(record(params), key) ?? "");
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

export interface Stripped {
  readonly requestIds: readonly string[];
  readonly params: Record<string, unknown>;
}

const BODY_FIELDS = new Set(["postData", "postDataEntries"]);

export function withoutBody(method: string, params: unknown): Stripped | undefined {
  if (!BODY_EVENTS.has(method)) return undefined;
  const fields = record(params);
  const request = record(fields?.["request"]);
  if (fields === undefined || request === undefined) return undefined;
  const rest = Object.fromEntries(Object.entries(request).filter(([key]) => !BODY_FIELDS.has(key)));
  const requestIds = [
    words(fields, "requestId"),
    words(fields, "networkId"),
    words(fields, "interceptionId"),
  ].filter((id) => id !== undefined);
  return { requestIds, params: { ...fields, request: rest } };
}
