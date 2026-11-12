const NUMBERED = /(?:^|(?<=[.:;?!)])\s+)(\d{1,2})\.\s+(?=\S)/g;
const TRAILING_PATH = /\s+((?:[\w.-]+:)?(?:~|\.)?\/\S+)\s*$/;

interface Marker {
  readonly at: number;
  readonly end: number;
  readonly number: number;
}

function markers(line: string): Marker[] {
  return [...line.matchAll(NUMBERED)].map((match) => ({
    at: match.index,
    end: match.index + match[0].length,
    number: Number(match[1]),
  }));
}

function listOf(found: readonly Marker[]): Marker[] {
  const list = found.filter((marker, index) => marker.number === index + 1);
  return list.length >= 2 && list.length === found.length ? list : [];
}

function numbered(line: string): string {
  const list = listOf(markers(line));
  const [first] = list;
  if (first === undefined) return line;
  const lead = line.slice(0, first.at).trimEnd();
  const items = list.map((marker, index) => {
    const next = list[index + 1];
    const item = line.slice(marker.end, next?.at ?? line.length).trim();
    return `${String(marker.number)}. ${item}`;
  });
  return `${lead === "" ? "" : `${lead}\n\n`}${items.join("\n")}`;
}

const apart = (line: string): string => line.replace(TRAILING_PATH, "\n$1");

export function laidOut(question: string): string {
  return question
    .split("\n")
    .map((line) => apart(numbered(line)))
    .join("\n");
}
