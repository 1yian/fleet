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

function fitStatus(text: string, width: number): string {
  const items = text.split(" · ").flatMap((item, at) => {
    const separator = at === 0 ? "" : " · ";
    if (!stripTerminalSequences(item).endsWith(" board")) return [{ text: item, separator }];
    const space = item.lastIndexOf(" ");
    return [
      { text: item.slice(0, space), separator },
      { text: item.slice(space + 1), separator: " " },
    ];
  });
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
      const whole = lines(Math.max(width, 4096))[STATUS_ROW] ?? "";
      rows[STATUS_ROW] = fitStatus(whole, width);
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
