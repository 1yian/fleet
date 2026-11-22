import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseRecord } from "./json.ts";

const WAV_MARK = "PCM16K:";
const state = process.env["FAKE_WHISPER_STATE"] ?? "";
const [tool = "", ...args] = process.argv.slice(2);
appendFileSync(`${state}.log`, `${JSON.stringify({ tool, args })}\n`);

function after(flag: string): string {
  const value = args[args.indexOf(flag) + 1];
  if (value === undefined) fail(`${tool}: ${flag} needs a value`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (tool === "ffmpeg") {
  const input = after("-i");
  if (!existsSync(input)) fail(`${input}: No such file or directory`);
  writeFileSync(args.at(-1) ?? "", Buffer.concat([Buffer.from(WAV_MARK), readFileSync(input)]));
} else if (tool === "whisper-cli") {
  const model = after("-m");
  if (!existsSync(model)) fail(`error: model file not found '${model}'`);
  const audio = readFileSync(after("-f"));
  if (!audio.toString("latin1").startsWith(WAV_MARK)) fail("error: failed to read audio data");
  console.error("ggml_metal_init: allocating");
  const { transcript } = parseRecord(readFileSync(state, "utf8"));
  const lines = Array.isArray(transcript) ? transcript : [];
  for (const line of lines) console.log(` ${String(line)}`);
} else {
  fail(`fake whisper: unknown tool ${tool}`);
}
