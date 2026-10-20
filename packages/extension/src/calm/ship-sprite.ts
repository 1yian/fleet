// The fleet mate's Calm working-ship sprite, ported from Firstmate's harness-neutral sprite.
//
// This module owns the sprite geometry, the bounce track, the two linked animation
// cadences, and the freeze/resume state of the working boat. It paints each frame as
// rows of color-tagged runs and never as bytes; ./ship.ts paints the runs as standard
// ANSI escapes for Pi's widget. docs/calm.md owns the user-facing contract.
//
// Cadence: one scheduler drives two linked cadences. Every tick advances the wave by
// one quarter-cell, and every CALM_WORKING_SHIP_TICKS_PER_MOVE-th tick moves the boat
// one whole cell, so the trough stays phase-locked to a deliberately calm boat.
// Ticks, not wall-clock timestamps, drive every state change.
//
// Continuity: one caller-owned sprite instance survives hide/show within one Pi process
// and extension lifetime. restoreLastRendered() freezes column, direction, water
// phase, and tick cadence at the last painted frame without advancing them for hidden
// wall time, and the next working period resumes from that exact logical state. A fresh
// session or new extension lifetime calls reset() and starts at the normal initial
// position. State is never a module-level or process-global singleton.

// The asymmetric three-cell sail is centered over a five-cell hull. The one-cell
// quarter triangle keeps the left sail lighter than the full right sail, and the whole
// boat (both sail halves, mast, and hull) is one color so the sprite reads as one shape.
// The hull's inner cells retain zero-height water glyphs instead of interrupting the trough.
const LEFT_SAIL = "◿";
const MAST = "│";
const RIGHT_SAIL = "◣";
const HULL_LEFT = "╲";
const HULL_WATER = "▁▁▁";
const HULL_RIGHT = "╱";
const SAIL_OFFSET = 1;

/** The complete sail as drawn, left to right. */
const CALM_WORKING_SHIP_SAIL = `${LEFT_SAIL}${MAST}${RIGHT_SAIL}`;
/** The complete hull as drawn, left to right. */
const CALM_WORKING_SHIP_HULL = `${HULL_LEFT}${HULL_WATER}${HULL_RIGHT}`;

/** Terminal columns a string of one-column glyphs occupies. */
function cellCount(text: string): number {
  return Array.from(text).length;
}

const HULL_WIDTH = cellCount(CALM_WORKING_SHIP_HULL);
const SAIL_WIDTH = cellCount(CALM_WORKING_SHIP_SAIL);

// Bottom-aligned one-cell bars. Calm keeps only their lower half: a long, low ocean
// swell rather than an audio-sized waveform. Every glyph is one terminal column.
const CALM_WORKING_SHIP_WAVE_BARS = ["▁", "▂", "▃", "▄"] as const;
const WAVE_MAX_LEVEL = CALM_WORKING_SHIP_WAVE_BARS.length - 1;
const WAVE_HALF_LENGTH_MIN = 9;
const WAVE_HALF_LENGTH_SPAN = 5;
const WAVE_TROUGH_RADIUS = 5;

/** Scheduler period. One tick advances the water by one phase. */
export const CALM_WORKING_SHIP_TICK_MS = 220;
/** Boat moves one column every Nth tick, so it travels at 220 * 4 = 880ms per column. */
const CALM_WORKING_SHIP_TICKS_PER_MOVE = 4;

/**
 * The color classes a frame uses. `plain` is uncolored padding; `water` is every water
 * cell whatever its height, so the swell reads through glyph height alone; `boat` is
 * the whole boat, both sail halves, the mast, and the complete hull including its
 * zero-height interior. ./ship.ts paints them as standard ANSI blue and yellow.
 */
export type CalmWorkingShipColor = "plain" | "water" | "boat";

/** One same-colored run of cells inside a frame row. */
export interface CalmWorkingShipRun {
  readonly text: string;
  readonly color: CalmWorkingShipColor;
}

/** One painted frame: one or two rows of runs, each row exactly the requested width. */
type CalmWorkingShipFrame = readonly (readonly CalmWorkingShipRun[])[];

export interface CalmWorkingShipSprite {
  /** Paint one frame that exactly fits `width`, clamping the track to it first. */
  frame: (width: number) => CalmWorkingShipFrame;
  /** Advance one scheduler tick: water every tick, boat on its slower cadence. */
  tick: () => void;
  /** Return to the state of the last painted frame, discarding later ticks. */
  restoreLastRendered: () => void;
  /** Restore the normal initial column, direction, water phase, and cadence. */
  reset: () => void;
}

/** Longest hull start column that still fits the sprite in `width` usable cells. */
function trackSpan(width: number): number {
  if (width >= HULL_WIDTH) return width - HULL_WIDTH;
  if (width >= SAIL_WIDTH) return width - SAIL_WIDTH;
  return 0;
}

/** Stable bounded variation for successive half-waves on either side of the trough. */
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

/** Smooth amplitude at one fractional cell in the deterministic variable wave field. */
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

/**
 * One bottom-aligned bar level at an absolute column.
 *
 * The wave advances one quarter-cell on every water tick and exactly one cell on the
 * boat's slower movement tick. Anchoring that displacement to the hull center keeps
 * the boat inside the same broad trough without per-frame randomness or jitter.
 */
function waveLevel(column: number, hullCenter: number, direction: number, phase: number): number {
  const displacement = hullCenter + (direction * phase) / CALM_WORKING_SHIP_TICKS_PER_MOVE;
  const coordinate = column - displacement;
  if (Math.abs(coordinate) <= WAVE_TROUGH_RADIUS) return 0;
  const beyondTrough = coordinate - Math.sign(coordinate) * WAVE_TROUGH_RADIUS;
  return Math.max(0, Math.min(WAVE_MAX_LEVEL, Math.round(waveAmplitude(beyondTrough))));
}

/** One water-colored run per cell of low water covering absolute columns [from, from + count). */
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

// The boat is one boat-colored run per row, so its halves never split into mismatched colors.
const sail: CalmWorkingShipRun[] = [{ text: CALM_WORKING_SHIP_SAIL, color: "boat" }];
const hull: CalmWorkingShipRun[] = [{ text: CALM_WORKING_SHIP_HULL, color: "boat" }];

/** One frame for a track already clamped to `width`, with the boat at `position`. */
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
    // Too narrow for even the sail: a deterministic single row of low water.
    return [water(0, width, wave)];
  }
  if (width < HULL_WIDTH) {
    // Too narrow for the hull: the sail alone rides inside the water row.
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

  // Reversing the moment the boat lands on an endpoint means the endpoint frame already
  // carries the new wave direction, so the trough follows the next boat movement.
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
      // A resize lands here before the next frame, so recompute and clamp the track
      // immediately rather than trusting a position measured against the old width.
      applyWidth(width);
      rendered = { ...now };
      return paint(width, now.position, now.direction, now.phase);
    },
  };
}
