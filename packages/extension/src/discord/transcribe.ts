import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { basename } from "node:path";
import type { GroqSpeech, LocalSpeech, SpeechConfig } from "./config.ts";
import { describeError, type Log } from "./log.ts";

const TRANSCRIBE_MS = 120_000;
const STDERR_MAX = 120;
const CAUSE = /^(error|fatal|libc\+\+abi)/i;

export type Transcribe = (file: string) => Promise<string | undefined>;

function reasonOf(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (lines.find((line) => CAUSE.test(line)) ?? lines.at(-1) ?? "").slice(0, STDERR_MAX);
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: TRANSCRIBE_MS, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const tool = basename(command);
        if (error.code === "ENOENT") {
          reject(new Error(`${tool} is not installed or not on the PATH`));
          return;
        }
        if (error.killed === true) {
          reject(new Error(`${tool} timed out`));
          return;
        }
        const reason = reasonOf(stderr);
        reject(new Error(`${tool} failed${reason === "" ? "" : `: ${reason}`}`));
      },
    );
  });
}

async function viaWhisper(speech: LocalSpeech, file: string): Promise<string> {
  const wav = `${file}.16k.wav`;
  try {
    await run(speech.ffmpeg, [
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-i",
      file,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      wav,
    ]);
    const lines = await run(speech.whisper, [
      "-m",
      speech.model,
      "-l",
      speech.language,
      "-nt",
      "-np",
      "-f",
      wav,
    ]);
    return lines
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(" ");
  } finally {
    rmSync(wav, { force: true });
  }
}

async function viaGroq(speech: GroqSpeech, file: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)]), basename(file));
  form.append("model", speech.model);
  form.append("response_format", "text");
  const response = await fetch(`${speech.url}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${speech.key}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_MS),
  });
  if (!response.ok) throw new Error(`Groq answered HTTP ${String(response.status)}`);
  return (await response.text()).trim();
}

export function transcriber(speech: SpeechConfig, log: Log): Transcribe {
  return async (file) => {
    try {
      const text =
        speech.engine === "groq" ? await viaGroq(speech, file) : await viaWhisper(speech, file);
      if (text === "") log("transcription found no speech");
      return text === "" ? undefined : text;
    } catch (error) {
      log(`transcription failed: ${describeError(error)}`);
      return undefined;
    }
  };
}
