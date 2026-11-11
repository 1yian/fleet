const MAX_BODY_ROWS = 16;
const MIN_BODY_ROWS = 2;
const FRAME_ROWS = 3;
const OVERDRAW_ROWS = 1;
const SPACER_ROWS = 3;
const TIGHTER_LIMITS = [2, 1];

export interface Shape {
  readonly title: readonly string[];
  readonly note: readonly string[];
  readonly hints: number;
  readonly limit: number;
}

export interface Layout extends Shape {
  readonly spacers: number;
  readonly body: number;
  readonly picks: number;
  readonly hidden: number;
}

const chromeOf = (shape: Shape): number =>
  FRAME_ROWS + shape.title.length + shape.note.length + shape.hints;

export function allocate(
  shaped: (limit: number) => Shape,
  heights: readonly number[],
  row: number,
  budget: number,
): Layout {
  const own = heights[row] ?? 1;
  const reach = budget + OVERDRAW_ROWS;
  let shape = shaped(Infinity);
  for (const limit of TIGHTER_LIMITS) {
    if (chromeOf(shape) + MIN_BODY_ROWS + own <= budget) break;
    shape = shaped(limit);
  }
  const chrome = chromeOf(shape);
  const free = budget - chrome;
  const wanted = heights.reduce((sum, each) => sum + each, 0);
  const owned = Math.min(own, Math.max(1, reach - chrome - 1));
  const picks = Math.min(wanted, Math.max(owned, free - MIN_BODY_ROWS));
  const left = free - picks;
  const spacers = Math.max(0, Math.min(SPACER_ROWS, left - MIN_BODY_ROWS));
  const body = Math.max(1, Math.min(MAX_BODY_ROWS, left - spacers));
  return { ...shape, spacers, body, picks, hidden: Math.max(0, own - picks) };
}
