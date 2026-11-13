import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { installPresentation, methodOf, once } from "./patch.ts";

const ELEMENT_TIMEOUT_MS = 15_000;
const FAILURE_NOTICE = Symbol.for("fleet:open-url-failure");

function notifyFailure(): void {
  const notify: unknown = Reflect.get(globalThis, FAILURE_NOTICE);
  if (typeof notify === "function") Reflect.apply(notify, undefined, []);
}

function elementShim(): string | undefined {
  const shim = join(process.env["ELEMENT_HOME"] ?? join(homedir(), ".element"), "el");
  try {
    accessSync(shim, constants.X_OK);
    return shim;
  } catch {
    return undefined;
  }
}

function openOnThisHost(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true, cwd: "/" })
    .on("error", () => undefined)
    .unref();
}

export function openForCaptain(url: string): void {
  const shim = elementShim();
  if (shim === undefined) {
    openOnThisHost(url);
    return;
  }
  let failed = false;
  const fail = (): void => {
    if (failed) return;
    failed = true;
    notifyFailure();
  };
  spawn(shim, ["open", url], { stdio: "ignore", timeout: ELEMENT_TIMEOUT_MS })
    .on("error", fail)
    .on("exit", (code) => {
      if (code !== 0) fail();
    });
}

export function routeLinkClicks(notify: () => void): void {
  Reflect.set(globalThis, FAILURE_NOTICE, notify);
  installPresentation("Links", "click", () => {
    once("alt-screen-open-url", () => {
      const proto = TuiAltScreen.prototype;
      const original = methodOf(proto, "handleSelectionMouseEvent");
      Reflect.set(proto, "handleSelectionMouseEvent", function (this: object, event: unknown) {
        Reflect.set(this, "openUrl", openForCaptain);
        return original(this, event);
      });
    });
  });
}
