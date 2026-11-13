import { FooterComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  visibleWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { installPresentation, methodOf, once, patchRender } from "./patch.ts";

export interface StatusClick {
  readonly text: string;
  readonly act: () => void;
}

const KEY = Symbol.for("fleet:status-clicks");
const STATUS_ROW = 2;
const drawn = new WeakMap<object, readonly string[]>();

function isClicks(value: unknown): value is Map<string, StatusClick> {
  return value instanceof Map;
}

function shared(): Map<string, StatusClick> {
  const found: unknown = Reflect.get(globalThis, KEY);
  if (isClicks(found)) return found;
  const created = new Map<string, StatusClick>();
  Reflect.set(globalThis, KEY, created);
  return created;
}

function clickedAt(footer: object, event: TuiMouseEvent): StatusClick | undefined {
  const plain = stripTerminalSequences(drawn.get(footer)?.[event.y] ?? "");
  return [...shared().values()].find((click) => {
    const at = plain.lastIndexOf(click.text);
    if (at === -1) return false;
    const start = visibleWidth(plain.slice(0, at));
    return event.x >= start && event.x < start + visibleWidth(click.text);
  });
}

function handleMouse(this: object, event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.type !== "click" || event.button !== "left") return undefined;
  const click = clickedAt(this, event);
  if (click === undefined) return undefined;
  click.act();
  return { handled: true };
}

function statusesOf(footer: object): string[] {
  const data: unknown = Reflect.get(footer, "footerData");
  const read: unknown =
    typeof data === "object" && data !== null
      ? Reflect.get(data, "getExtensionStatuses")
      : undefined;
  const found: unknown = typeof read === "function" ? Reflect.apply(read, data, []) : undefined;
  if (!(found instanceof Map)) return [];
  const statuses = new Map<string, string>();
  for (const [key, text] of found) {
    if (typeof key === "string" && typeof text === "string") statuses.set(key, text);
  }
  return [...statuses.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((key) =>
      (statuses.get(key) ?? "")
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim(),
    );
}

function fitStatus(footer: object, width: number): string {
  const items = statusesOf(footer).flatMap((status, at) =>
    status
      .split(" · ")
      .map((text, inner) => ({ text, separator: inner === 0 ? (at === 0 ? "" : " ") : " · " })),
  );
  let fitted = "";
  for (const item of items) {
    const next = fitted + (fitted === "" ? "" : item.separator) + item.text;
    if (visibleWidth(next) <= width) fitted = next;
  }
  return fitted;
}

function wrapCustomFooter(footer: object): void {
  const render = methodOf(footer, "render");
  const mouse: unknown = Reflect.get(footer, "handleMouse");
  Reflect.set(footer, "render", function (this: object, width: number) {
    const rows: unknown = render(this, width);
    if (Array.isArray(rows) && rows.every((row) => typeof row === "string")) drawn.set(this, rows);
    return rows;
  });
  Reflect.set(footer, "handleMouse", function (this: object, event: TuiMouseEvent) {
    const click = handleMouse.call(this, event);
    if (click !== undefined) return click;
    const result: unknown =
      typeof mouse === "function" ? Reflect.apply(mouse, this, [event]) : undefined;
    return result;
  });
}

function install(): void {
  once("custom-footer-mouse", () => {
    const proto = InteractiveMode.prototype;
    const original = methodOf(proto, "setExtensionFooter");
    Reflect.set(proto, "setExtensionFooter", function (this: object, factory: unknown) {
      const result = original(this, factory);
      const footer: unknown = Reflect.get(this, "customFooter");
      if (typeof footer === "object" && footer !== null) wrapCustomFooter(footer);
      return result;
    });
  });
  patchRender(FooterComponent.prototype, "FooterComponent", (footer, width, lines) => {
    const rows = lines();
    if (stripTerminalSequences(rows[STATUS_ROW] ?? "").endsWith("...")) {
      rows[STATUS_ROW] = fitStatus(footer, width);
    }
    drawn.set(
      footer,
      rows.map((row, at) => (at === STATUS_ROW ? row : "")),
    );
    return rows;
  });
  once("footer-mouse", () => {
    Reflect.set(FooterComponent.prototype, "handleMouse", handleMouse);
  });
}

export function installStatusClicks(): void {
  installPresentation("Status", "click", install);
}

export function onStatusClick(key: string, click: StatusClick | undefined): void {
  installStatusClicks();
  if (click === undefined) shared().delete(key);
  else shared().set(key, click);
}
