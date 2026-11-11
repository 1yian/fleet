const ESCAPE = "\u001b";
const ENTER = ["\r", "\n"];
const BACKSPACE = ["\u007f", "\b"];
const INTERRUPT = "\u0003";

function readChunk(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (data: Buffer) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(data.toString("utf8"));
    });
  });
}

export const hasTerminal = (): boolean => process.stdin.isTTY && process.stdout.isTTY;

export async function pressAnyKey(): Promise<void> {
  if (!hasTerminal()) return;
  process.stdout.write("\n(press any key)");
  await readChunk();
  process.stdout.write("\n");
}

export async function confirm(question: string, allowNote: boolean): Promise<string | undefined> {
  if (!hasTerminal())
    throw new Error("fleet files: sending needs a terminal for its confirm prompt");
  let note = "";
  for (;;) {
    process.stdout.write(`\r\u001b[K${question}${allowNote ? ` note: ${note}` : ""}`);
    const chunk = await readChunk();
    if (chunk === ESCAPE || chunk === INTERRUPT) return undefined;
    if (ENTER.includes(chunk)) return note;
    if (BACKSPACE.includes(chunk)) note = note.slice(0, -1);
    else if (allowNote && !chunk.startsWith(ESCAPE)) note += chunk.replace(/[\r\n]+/g, " ");
  }
}
