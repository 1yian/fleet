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

const BODY_EVENTS = new Set(["Network.requestWillBeSent", "Fetch.requestPaused"]);

const domainOf = (method: string): string => method.slice(0, method.indexOf("."));

const runsScript = (params: unknown): boolean =>
  /^\s*javascript:/i.test(words(record(params), "url") ?? "");

export function refusedAlways(method: string): boolean {
  return REFUSED_ALWAYS.has(method);
}

export function allowedWhileTyped(method: string, params: unknown): boolean {
  if (method === "Network.getRequestPostData") return false;
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
  const requestIds = [words(fields, "requestId"), words(fields, "networkId")].filter(
    (id) => id !== undefined,
  );
  return { requestIds, params: { ...fields, request: rest } };
}

export function navigationUrl(method: string, params: unknown): string | undefined {
  const fields = record(params);
  if (method === "Page.frameRequestedNavigation")
    return words(fields, "reason") === "formSubmissionGet" ? words(fields, "url") : undefined;
  const document =
    method === "Network.requestWillBeSent"
      ? words(fields, "type") === "Document"
      : method === "Fetch.requestPaused" && words(fields, "resourceType") === "Document";
  return document ? words(record(fields?.["request"]), "url") : undefined;
}
