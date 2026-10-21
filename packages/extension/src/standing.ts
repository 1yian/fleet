import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneHomes } from "./homes.ts";

type Tier = "pinned" | "aging" | "perishable";
type Standing = "captain.md" | "captain-shared.md" | "learnings.md";

interface StandingFile {
  readonly file: Standing;
  readonly heading: string;
  readonly defaultTier: Tier;
}

const SHARED: Standing = "captain-shared.md";
const STALE_AFTER_DAYS = { aging: 30, perishable: 7 } as const;
const DAY_MS = 86_400_000;
const READ_ONLY = 0o444;

const STANDING: readonly StandingFile[] = [
  { file: SHARED, heading: "the captain's preferences shared across lanes", defaultTier: "pinned" },
  { file: "captain.md", heading: "the captain's preferences for this lane", defaultTier: "pinned" },
  { file: "learnings.md", heading: "what this home has learned", defaultTier: "aging" },
];

const pathOf = (home: string, file: Standing): string => join(home, "data", file);

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export const readShared = (home: string): string | undefined => readIfPresent(pathOf(home, SHARED));

export function standingRules(home: string): string {
  const sections = STANDING.flatMap(({ file, heading }) => {
    const text = readIfPresent(pathOf(home, file))?.trim() ?? "";
    return text === "" ? [] : [`### data/${file}: ${heading}\n\n${text}`];
  });
  if (sections.length === 0) return "";
  const rules = [
    "## Standing rules",
    "These are the captain's standing preferences and what this home has learned. They load from `data/` on every turn.",
    "A current, explicit instruction from the captain wins over any of them, within the scope he stated.",
  ];
  return `\n\n${[...rules, ...sections].join("\n\n")}`;
}

const publishedFile = (home: string): string => join(home, "state", "captain-shared.published");

function preserveAside(home: string, current: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  for (let n = 0; ; n += 1) {
    const name = `captain-shared.edited-${stamp}${n === 0 ? "" : `-${String(n)}`}.md`;
    try {
      writeFileSync(join(home, "data", name), current, { flag: "wx", mode: 0o600 });
      return name;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
}

function publish(path: string, bytes: string, mode: number): void {
  const next = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(next, bytes, { mode });
  renameSync(next, path);
}

function converge(home: string, bytes: string | undefined): string {
  mkdirSync(join(home, "data"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  const target = pathOf(home, SHARED);
  const current = readIfPresent(target);
  const published = readIfPresent(publishedFile(home));
  const edited = current !== undefined && current !== bytes && current !== published;
  const kept = edited ? preserveAside(home, current) : undefined;
  const aside = kept === undefined ? "" : `, edited copy preserved as data/${kept}`;
  if (bytes === undefined) {
    if (current === undefined) return "unchanged";
    rmSync(target);
    rmSync(publishedFile(home), { force: true });
    return `removed${aside}`;
  }
  if (current !== bytes) publish(target, bytes, READ_ONLY);
  chmodSync(target, READ_ONLY);
  if (published !== bytes) publish(publishedFile(home), bytes, 0o600);
  return current === bytes ? "unchanged" : `updated${aside}`;
}

export function convergeSharedPreferences(
  root: string,
  bytes: string | undefined,
): { lane: string; result: string }[] {
  return laneHomes(root).map(({ lane, home }) => ({ lane, result: converge(home, bytes) }));
}

interface Entry {
  readonly text: string;
  readonly status: "pinned" | "current" | "stale" | "grace" | "unmarked";
  readonly tier?: Tier;
  readonly days?: number;
}

const MARKER = /\s*<!--(?:([ap]):(\d{4}-\d{2}-\d{2})(?:\/\d+)?|(P)|(g))-->\s*$/;

function classify(line: string, file: StandingFile, today: Date): Entry {
  const marker = MARKER.exec(line);
  const text = line.replace(MARKER, "").replace(/^-\s+/, "").trim();
  if (marker === null)
    return file.defaultTier === "pinned"
      ? { text, status: "pinned" }
      : { text, status: "unmarked" };
  if (marker[3] !== undefined) return { text, status: "pinned" };
  if (marker[4] !== undefined) return { text, status: "grace" };
  const tier = marker[1] === "a" ? "aging" : "perishable";
  const from = Date.parse(`${marker[2] ?? ""}T00:00:00Z`);
  const days = Math.floor((today.getTime() - from) / DAY_MS);
  return { text, tier, days, status: days >= STALE_AFTER_DAYS[tier] ? "stale" : "current" };
}

function entriesOf(text: string, file: StandingFile, today: Date): Entry[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => classify(line, file, today));
}

function line({ status, text, tier, days }: Entry): string {
  if (tier === undefined || days === undefined) return `- ${status}: ${text}`;
  return `- ${status === "stale" ? "STALE" : status} ${tier} ${String(days)}d: ${text}`;
}

export function memoryReport(home: string, lane: string, now: Date): string {
  const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const blocks = STANDING.map((file) => {
    const text = readIfPresent(pathOf(home, file.file));
    const owner = file.file === SHARED && lane !== "main" ? "read-only: main's copy" : "editable";
    if (text === undefined) return `data/${file.file} (absent)`;
    const entries = entriesOf(text, file, today).map(line);
    return [`data/${file.file} (${owner})`, ...entries].join("\n");
  });
  return [`## Memory files now (today ${today.toISOString().slice(0, 10)})`, ...blocks].join(
    "\n\n",
  );
}
