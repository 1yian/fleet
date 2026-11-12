import { FooterComponent } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  visibleWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { installPresentation, once, patchRender } from "./patch.ts";

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
  if (event.y !== STATUS_ROW) return undefined;
  const plain = stripTerminalSequences(drawn.get(footer)?.[STATUS_ROW] ?? "");
  return [...shared().values()].find((click) => {
    const at = plain.indexOf(click.text);
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

function install(): void {
  patchRender(FooterComponent.prototype, "FooterComponent", (footer, width, lines) => {
    const rows = lines();
    if (stripTerminalSequences(rows[STATUS_ROW] ?? "").endsWith("...")) {
      rows[STATUS_ROW] = fitStatus(footer, width);
    }
    drawn.set(footer, rows);
    return rows;
  });
  once("footer-mouse", () => {
    Reflect.set(FooterComponent.prototype, "handleMouse", handleMouse);
  });
}

export function onStatusClick(key: string, click: StatusClick | undefined): void {
  installPresentation("Status", "click", install);
  if (click === undefined) shared().delete(key);
  else shared().set(key, click);
}
