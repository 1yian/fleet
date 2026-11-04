import { parseCdp } from "@fleet/protocol";
import Type from "typebox";
import { call, type Page } from "./browser-page.ts";

const Ints = Type.Array(Type.Integer());
const Boxes = Type.Array(Type.Array(Type.Number()));
const Pairs = Type.Object({ index: Ints, value: Ints });
const DocumentSchema = Type.Object({
  frameId: Type.Integer(),
  nodes: Type.Object({
    parentIndex: Type.Optional(Ints),
    nodeType: Type.Optional(Ints),
    nodeName: Type.Optional(Ints),
    nodeValue: Type.Optional(Ints),
    attributes: Type.Optional(Type.Array(Ints)),
    inputValue: Type.Optional(Pairs),
    contentDocumentIndex: Type.Optional(Pairs),
  }),
  layout: Type.Object({
    nodeIndex: Ints,
    bounds: Boxes,
    text: Ints,
    paintOrders: Type.Optional(Ints),
  }),
  textBoxes: Type.Object({ layoutIndex: Ints, bounds: Boxes, start: Ints, length: Ints }),
});
const SnapshotSchema = Type.Object({
  documents: Type.Array(DocumentSchema),
  strings: Type.Array(Type.String()),
});

type Document = Type.Static<typeof DocumentSchema>;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Placed {
  readonly rect: Rect;
  readonly paint: number;
}

export interface Scanned {
  readonly frame: string;
  readonly hits: Placed[];
  readonly boxes: Placed[];
  readonly remote: number;
}

const MARK = "data-fleet-cover";
const PLACEHOLDERS = ["placeholder", "alt"];

const rectOf = (bounds: readonly number[] | undefined): Rect | undefined => {
  const [x, y, width, height] = bounds ?? [];
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return undefined;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
};

function fold(text: string): string {
  return Array.from(text, (char) => {
    if (/\s/.test(char)) return " ";
    const lower = char.toLowerCase();
    return lower.length === char.length ? lower : char;
  }).join("");
}

const squash = (text: string): string => text.replace(/\s+/g, " ").toLowerCase();

interface Joined {
  readonly flat: string;
  readonly places: readonly (readonly [number, number])[];
}

function join(texts: readonly { layout: number; text: string }[]): Joined {
  const chars: string[] = [];
  const places: [number, number][] = [];
  let last = "";
  for (const { layout, text } of texts) {
    const folded = fold(text);
    for (let at = 0; at < folded.length; at += 1) {
      const char = folded.charAt(at);
      if (char === " " && last === " ") continue;
      last = char;
      chars.push(char);
      places.push([layout, at]);
    }
  }
  return { flat: chars.join(""), places };
}

class Reading {
  private readonly doc: Document;
  private readonly strings: readonly string[];
  private readonly layoutOf = new Map<number, number>();

  constructor(doc: Document, strings: readonly string[]) {
    this.doc = doc;
    this.strings = strings;
    doc.layout.nodeIndex.forEach((node, layout) => {
      this.layoutOf.set(node, layout);
    });
  }

  private string(index: number | undefined): string {
    return index === undefined || index < 0 ? "" : (this.strings[index] ?? "");
  }

  private nameOf(node: number): string {
    return this.string(this.doc.nodes.nodeName?.[node]);
  }

  private placed(layout: number | undefined): Placed | undefined {
    if (layout === undefined) return undefined;
    const rect = rectOf(this.doc.layout.bounds[layout]);
    return rect === undefined
      ? undefined
      : { rect, paint: this.doc.layout.paintOrders?.[layout] ?? 0 };
  }

  private ofNode(node: number | undefined): Placed[] {
    const found = node === undefined ? undefined : this.placed(this.layoutOf.get(node));
    return found === undefined ? [] : [found];
  }

  private ancestor(node: number, name: string): number | undefined {
    for (let at: number | undefined = node; at !== undefined && at >= 0;) {
      if (this.nameOf(at) === name) return at;
      const parent: number | undefined = this.doc.nodes.parentIndex?.[at];
      at = parent;
    }
    return undefined;
  }

  frame(): string {
    return this.string(this.doc.frameId);
  }

  remote(): number {
    const loaded = new Set(this.doc.nodes.contentDocumentIndex?.index ?? []);
    const names = this.doc.nodes.nodeName ?? [];
    return names.filter(
      (name, node) => ["IFRAME", "FRAME"].includes(this.string(name)) && !loaded.has(node),
    ).length;
  }

  boxes(): Placed[] {
    return (this.doc.nodes.attributes ?? []).flatMap((pairs, node) => {
      for (let at = 0; at + 1 < pairs.length; at += 2)
        if (this.string(pairs[at]) === MARK && this.string(pairs[at + 1]) === "box")
          return this.ofNode(node);
      return [];
    });
  }

  private boxesIn(layout: number, low: number, high: number): Rect[] {
    const { textBoxes } = this.doc;
    return textBoxes.layoutIndex.flatMap((owner, box) => {
      const start = textBoxes.start[box] ?? 0;
      const end = start + (textBoxes.length[box] ?? 0);
      const rect =
        owner === layout && start <= high && end > low ? rectOf(textBoxes.bounds[box]) : undefined;
      return rect === undefined ? [] : [rect];
    });
  }

  private hitsOf(span: ReadonlyMap<number, readonly [number, number]>): Placed[] {
    const { layout } = this.doc;
    return [...span].flatMap(([at, [low, high]]) => {
      const paint = layout.paintOrders?.[at] ?? 0;
      const boxes = this.boxesIn(at, low, high);
      return boxes.length === 0
        ? this.ofNode(layout.nodeIndex[at])
        : boxes.map((rect) => ({ rect, paint }));
    });
  }

  textHits(needles: readonly string[]): Placed[] {
    const texts = this.doc.layout.text.flatMap((index, at) =>
      index < 0 ? [] : [{ layout: at, text: this.string(index) }],
    );
    const { flat, places } = join(texts);
    const hits: Placed[] = [];
    for (const needle of needles.map(squash).filter((each) => each.trim() !== "")) {
      for (let from = flat.indexOf(needle); from >= 0; from = flat.indexOf(needle, from + 1)) {
        const span = new Map<number, [number, number]>();
        for (const [at, offset] of places.slice(from, from + needle.length)) {
          const seen = span.get(at) ?? [offset, offset];
          span.set(at, [Math.min(seen[0], offset), Math.max(seen[1], offset)]);
        }
        hits.push(...this.hitsOf(span));
      }
    }
    return hits;
  }

  fieldHits(needles: readonly string[]): Placed[] {
    const matches = (text: string): boolean => {
      const folded = squash(text);
      return needles.map(squash).some((needle) => needle.trim() !== "" && folded.includes(needle));
    };
    const { nodes } = this.doc;
    const values = (nodes.inputValue?.index ?? []).flatMap((node, at) =>
      matches(this.string(nodes.inputValue?.value[at])) ? this.ofNode(node) : [],
    );
    const attributes = (nodes.attributes ?? []).flatMap((pairs, node) => {
      for (let at = 0; at + 1 < pairs.length; at += 2)
        if (PLACEHOLDERS.includes(this.string(pairs[at])) && matches(this.string(pairs[at + 1])))
          return this.ofNode(node);
      return [];
    });
    const options = (nodes.nodeType ?? []).flatMap((type, node) => {
      const inside = type === 3 && matches(this.string(nodes.nodeValue?.[node]));
      return inside ? this.ofNode(this.ancestor(node, "SELECT")) : [];
    });
    return [...values, ...attributes, ...options];
  }
}

export function scan(raw: unknown, needles: readonly string[]): Scanned[] {
  const snapshot = parseCdp(SnapshotSchema, raw, "the page's layout");
  return snapshot.documents.map((doc) => {
    const reading = new Reading(doc, snapshot.strings);
    return {
      frame: reading.frame(),
      hits: [...reading.textHits(needles), ...reading.fieldHits(needles)],
      boxes: reading.boxes(),
      remote: reading.remote(),
    };
  });
}

export async function snapshotOf(page: Page): Promise<unknown> {
  return call(page, "DOMSnapshot.captureSnapshot", {
    computedStyles: [],
    includePaintOrder: true,
    includeDOMRects: false,
  });
}

export const covers = (box: Placed, hit: Placed): boolean =>
  box.paint > hit.paint &&
  box.rect.x <= hit.rect.x + 1 &&
  box.rect.y <= hit.rect.y + 1 &&
  box.rect.x + box.rect.width >= hit.rect.x + hit.rect.width - 1 &&
  box.rect.y + box.rect.height >= hit.rect.y + hit.rect.height - 1;
