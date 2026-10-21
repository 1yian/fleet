const LEFT_SAIL = "◿";
const MAST = "│";
const RIGHT_SAIL = "◣";
const HULL_LEFT = "╲";
const HULL_WATER = "▁▁▁";
const HULL_RIGHT = "╱";
const SAIL_OFFSET = 1;

const CALM_WORKING_SHIP_SAIL = `${LEFT_SAIL}${MAST}${RIGHT_SAIL}`;
const CALM_WORKING_SHIP_HULL = `${HULL_LEFT}${HULL_WATER}${HULL_RIGHT}`;

function cellCount(text: string): number {
  return Array.from(text).length;
}

const HULL_WIDTH = cellCount(CALM_WORKING_SHIP_HULL);
const SAIL_WIDTH = cellCount(CALM_WORKING_SHIP_SAIL);

const CALM_WORKING_SHIP_WAVE_BARS = ["▁", "▂", "▃", "▄"] as const;
const WAVE_MAX_LEVEL = CALM_WORKING_SHIP_WAVE_BARS.length - 1;
const WAVE_HALF_LENGTH_MIN = 9;
const WAVE_HALF_LENGTH_SPAN = 5;
const WAVE_TROUGH_RADIUS = 5;

export const CALM_WORKING_SHIP_TICK_MS = 220;
const CALM_WORKING_SHIP_TICKS_PER_MOVE = 4;

export type CalmWorkingShipColor = "plain" | "water" | "boat";

export interface CalmWorkingShipRun {
  readonly text: string;
  readonly color: CalmWorkingShipColor;
}

type CalmWorkingShipFrame = readonly (readonly CalmWorkingShipRun[])[];

export interface CalmWorkingShipSprite {
  frame: (width: number) => CalmWorkingShipFrame;
  tick: () => void;
  restoreLastRendered: () => void;
  reset: () => void;
}

function trackSpan(width: number): number {
  if (width >= HULL_WIDTH) return width - HULL_WIDTH;
  if (width >= SAIL_WIDTH) return width - SAIL_WIDTH;
  return 0;
}

function halfWaveLength(index: number, negative: boolean): number {
  let value = ((negative ? 0xc411 : 0x5ea1) + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value >>>= 0;
  return WAVE_HALF_LENGTH_MIN + (value % WAVE_HALF_LENGTH_SPAN);
}

function smoothstep(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function waveAmplitude(coordinate: number): number {
  const negative = coordinate < 0;
  let distance = Math.abs(coordinate);
  let rising = true;
  for (let index = 0; ; index += 1) {
    const length = halfWaveLength(index, negative);
    if (distance <= length) {
      const eased = smoothstep(distance / length);
      return (rising ? eased : 1 - eased) * WAVE_MAX_LEVEL;
    }
    distance -= length;
    rising = !rising;
  }
}

function waveLevel(column: number, hullCenter: number, direction: number, phase: number): number {
  const displacement = hullCenter + (direction * phase) / CALM_WORKING_SHIP_TICKS_PER_MOVE;
  const coordinate = column - displacement;
  if (Math.abs(coordinate) <= WAVE_TROUGH_RADIUS) return 0;
  const beyondTrough = coordinate - Math.sign(coordinate) * WAVE_TROUGH_RADIUS;
  return Math.max(0, Math.min(WAVE_MAX_LEVEL, Math.round(waveAmplitude(beyondTrough))));
}

function water(from: number, count: number, wave: Wave): CalmWorkingShipRun[] {
  const runs: CalmWorkingShipRun[] = [];
  for (let column = from; column < from + count; column += 1) {
    const level = waveLevel(column, wave.hullCenter, wave.direction, wave.phase);
    runs.push({
      text: CALM_WORKING_SHIP_WAVE_BARS[level] ?? CALM_WORKING_SHIP_WAVE_BARS[0],
      color: "water",
    });
  }
  return runs;
}

interface Wave {
  readonly hullCenter: number;
  readonly direction: number;
  readonly phase: number;
}

const sail: CalmWorkingShipRun[] = [{ text: CALM_WORKING_SHIP_SAIL, color: "boat" }];
const hull: CalmWorkingShipRun[] = [{ text: CALM_WORKING_SHIP_HULL, color: "boat" }];

function paint(
  width: number,
  position: number,
  direction: number,
  phase: number,
): CalmWorkingShipFrame {
  const hullCenter =
    position + (width >= HULL_WIDTH ? Math.floor(HULL_WIDTH / 2) : Math.floor(SAIL_WIDTH / 2));
  const wave = { hullCenter, direction, phase };
  if (width < SAIL_WIDTH) {
    return [water(0, width, wave)];
  }
  if (width < HULL_WIDTH) {
    return [
      [
        ...water(0, position, wave),
        ...sail,
        ...water(position + SAIL_WIDTH, width - position - SAIL_WIDTH, wave),
      ],
    ];
  }
  return [
    [{ text: " ".repeat(position + SAIL_OFFSET), color: "plain" }, ...sail],
    [
      ...water(0, position, wave),
      ...hull,
      ...water(position + HULL_WIDTH, width - position - HULL_WIDTH, wave),
    ],
  ];
}

interface Motion {
  position: number;
  direction: number;
  span: number;
  phase: number;
  ticks: number;
}

const INITIAL: Motion = { position: 0, direction: 1, span: 0, phase: 0, ticks: 0 };

export function createCalmWorkingShipSprite(): CalmWorkingShipSprite {
  let now: Motion = { ...INITIAL };
  let rendered: Motion = { ...INITIAL };

  const settleDirectionAtEdges = (): void => {
    if (now.span <= 0) return;
    if (now.position >= now.span) now.direction = -1;
    else if (now.position <= 0) now.direction = 1;
  };

  const applyWidth = (width: number): void => {
    now.span = trackSpan(width);
    now.position = Math.min(now.position, now.span);
    settleDirectionAtEdges();
  };

  return {
    restoreLastRendered: () => {
      now = { ...rendered };
    },
    reset: () => {
      now = { ...INITIAL };
      rendered = { ...INITIAL };
    },
    tick: () => {
      now.ticks += 1;
      now.phase = (now.phase + 1) % CALM_WORKING_SHIP_TICKS_PER_MOVE;
      if (now.ticks % CALM_WORKING_SHIP_TICKS_PER_MOVE !== 0) return;
      now.position = Math.min(now.span, Math.max(0, now.position + now.direction));
      settleDirectionAtEdges();
    },
    frame: (width) => {
      if (width <= 0) return [];
      applyWidth(width);
      rendered = { ...now };
      return paint(width, now.position, now.direction, now.phase);
    },
  };
}
