const ESCAPE = "\u001b";
const ENTER = ["\r", "\n"];
const BACKSPACE = ["\u007f", "\b"];
const INTERRUPT = "\u0003";

const hasTerminal = (): boolean => process.stdin.isTTY && process.stdout.isTTY;

export function clearScreen(): void {
  if (hasTerminal()) process.stdout.write("\u001b[2J\u001b[H");
}

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

export async function pressAnyKey(): Promise<void> {
  if (!hasTerminal()) return;
  process.stdout.write("\n(press any key)");
  await readChunk();
  process.stdout.write("\n");
}

export function confirm(question: string, allowNote: boolean): Promise<string | undefined> {
  if (!hasTerminal())
    throw new Error("fleet files: sending needs a terminal for its confirm prompt");
  return new Promise((resolve) => {
    let note = "";
    const draw = (): void => {
      process.stdout.write(`\r\u001b[K${question}${allowNote ? ` note: ${note}` : ""}`);
    };
    const finish = (answer: string | undefined): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(answer);
    };
    const onData = (data: Buffer): void => {
      const chunk = data.toString("utf8");
      if (chunk === ESCAPE || chunk.includes(INTERRUPT)) {
        finish(undefined);
        return;
      }
      const typed = chunk.startsWith(ESCAPE) ? [] : Array.from(chunk);
      for (const char of typed) {
        if (ENTER.includes(char)) {
          finish(note);
          return;
        }
        if (BACKSPACE.includes(char)) note = note.slice(0, -1);
        else if (allowNote) note += char;
      }
      draw();
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    draw();
  });
}
