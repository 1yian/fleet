import type { Lane } from "./lane.js";

const ALWAYS_DENIED = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Network.getAllCookies",
  "Network.getCookies",
  "Storage.getCookies",
  "Storage.getStorageKeyForFrame",
]);

const READ_ONLY = [
  /^[A-Za-z]+\.(enable|disable)$/,
  /^Target\.(setAutoAttach|setDiscoverTargets|attachToTarget|detachFromTarget|getTargets|getTargetInfo|getBrowserContexts)$/,
  /^Browser\.(getVersion|getWindowForTarget|getWindowBounds)$/,
  /^Page\.(captureScreenshot|getFrameTree|getNavigationHistory|getLayoutMetrics|getResourceTree|setLifecycleEventsEnabled)$/,
  /^DOM\.(getDocument|describeNode|querySelector|querySelectorAll|resolveNode|requestChildNodes|getBoxModel|getContentQuads|getOuterHTML|requestNode|pushNodesByBackendIdsToFrontend|collectClassNamesFromSubtree)$/,
  /^Runtime\.(runIfWaitingForDebugger|getProperties|releaseObject|releaseObjectGroup)$/,
  /^(Accessibility|CSS|DOMSnapshot|Log|Performance|Inspector)\./,
  /^Network\.(setCacheDisabled|getResponseBody)$/,
];

export function agentCommandError(lane: Lane, method: string): string | null {
  if (ALWAYS_DENIED.has(method)) return `fleet-browser does not allow ${method}`;
  const lock = lane.agentLock();
  if (lock && !READ_ONLY.some((pattern) => pattern.test(method))) {
    return `lane ${lane.name} is ${lock}; reads still work. Run \`fleet-browser handoff wait\` or retry after the captain presses Done`;
  }
  return null;
}
