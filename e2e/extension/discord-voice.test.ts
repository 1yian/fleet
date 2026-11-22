import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { bridgeSettings, CAPTAIN, EXTENSION, ONLINE, userTexts } from "../support/bridge-env.ts";
import { Cardd } from "../support/cardd.ts";
import { FakeDiscord } from "../support/fake-discord.ts";
import { FakeWhisper } from "../support/fake-whisper.ts";
import { askBridge, isStamp, waitForStatus } from "../support/bridge-status.ts";
import { Harness, poll, type Pi } from "../support/harness.ts";

const VOICE_MESSAGE = 8192;
const RECORDING = Buffer.from("4f676753000200000000000000000000", "hex");
const MEDIA = /state\/discord-bridge\/media\/.+-voice-message\.ogg/;

let cardd: Cardd;
let h: Harness;
let discord: FakeDiscord;
beforeEach(async () => {
  cardd = await Cardd.start();
  h = await Harness.start();
  discord = await FakeDiscord.start();
});
afterEach(async () => {
  await h.stop();
  await discord.stop();
  await cardd.stop();
});

const home = (): string => join(h.dir, "work");

async function startMain(settings: Record<string, string>): Promise<Pi> {
  const pi = h.startPi(
    "main",
    {
      FLEET_URL: cardd.url,
      FLEET_TOKEN: cardd.addLane("main"),
      FLEET_ROLE: "mate",
      FLEET_LANE: "main",
      ...bridgeSettings(discord, settings),
    },
    [EXTENSION],
  );
  await discord.waitForPost((post) => post.content === ONLINE, "the online notice");
  return pi;
}

async function assertSpoke(pi: Pi, engine: string, result: string): Promise<void> {
  const read = await waitForStatus(home(), `speech to report ${result}`, (status) =>
    isStamp(status("speech.at")),
  );
  assert.equal(read("speech.engine"), engine);
  assert.equal(read("speech.result"), result);
  assert.match(
    await askBridge(pi),
    new RegExp(`speech \\(${engine}\\): last result ${result}, \\S+`),
  );
}

const voiceNote = (): void => {
  discord.say({
    author: CAPTAIN,
    content: "",
    flags: VOICE_MESSAGE,
    attachments: [{ name: "voice-message.ogg", bytes: RECORDING }],
  });
};

const logged = (text: string): Promise<string> =>
  poll(() => {
    const file = join(h.dir, "work", "state", "discord-bridge", "bridge.log");
    const log = existsSync(file) ? readFileSync(file, "utf8") : "";
    return log.includes(text) ? log : undefined;
  }, "the bridge log");

test("a voice message is transcribed on the host by whisper.cpp, with no network call", async () => {
  const whisper = new FakeWhisper(["move the standup", "to noon"]);
  h.onModel(() => ({ text: "Moved." }));
  const pi = await startMain({ ...whisper.env, BRIDGE_WHISPER_LANGUAGE: "en" });

  voiceNote();
  assert.equal(userTexts(await h.waitForCall(0)).at(-1), "move the standup to noon");

  const [decode = []] = whisper.calls("ffmpeg");
  const input = decode[decode.indexOf("-i") + 1] ?? "";
  const wav = decode.at(-1) ?? "";
  assert.match(input, MEDIA);
  assert.deepEqual(
    decode.filter((arg) => arg !== input && arg !== wav),
    ["-nostdin", "-v", "error", "-y", "-i", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"],
  );
  assert.equal(whisper.calls("ffmpeg").length, 1);
  assert.deepEqual(whisper.calls("whisper-cli"), [
    ["-m", whisper.model, "-l", "en", "-nt", "-np", "-f", wav],
  ]);
  assert.equal(existsSync(wav), false, "the converted audio was left behind");
  assert.deepEqual(readFileSync(input), RECORDING);
  assert.deepEqual(discord.transcriptions, []);
  await assertSpoke(pi, "local", "ok");
});

test("the language is detected unless BRIDGE_WHISPER_LANGUAGE names one", async () => {
  const whisper = new FakeWhisper(["hello"]);
  h.onModel(() => ({ text: "Hi." }));
  await startMain(whisper.env);

  voiceNote();
  await h.waitForCall(0);
  const [call = []] = whisper.calls("whisper-cli");
  assert.deepEqual(call.slice(0, 4), ["-m", whisper.model, "-l", "auto"]);
});

test("a voice message is transcribed by Groq only when BRIDGE_STT is groq", async () => {
  discord.transcript = "move the standup to noon";
  const whisper = new FakeWhisper(["not this one"]);
  h.onModel(() => ({ text: "Moved." }));
  const pi = await startMain({
    ...whisper.env,
    BRIDGE_STT: "groq",
    BRIDGE_GROQ_API_KEY: discord.groqKey,
    BRIDGE_GROQ_MODEL: "whisper-test",
    BRIDGE_GROQ_API_URL: discord.groqUrl,
  });

  voiceNote();
  assert.equal(userTexts(await h.waitForCall(0)).at(-1), "move the standup to noon");
  assert.deepEqual(
    discord.transcriptions.map((each) => ({
      authorization: each.authorization,
      model: each.model,
      bytes: each.bytes.toString("hex"),
    })),
    [
      {
        authorization: `Bearer ${discord.groqKey}`,
        model: "whisper-test",
        bytes: RECORDING.toString("hex"),
      },
    ],
  );
  assert.deepEqual([whisper.calls("ffmpeg"), whisper.calls("whisper-cli")], [[], []]);
  await assertSpoke(pi, "groq", "ok");
});

test("a Groq key alone does not send the audio to Groq", async () => {
  discord.transcript = "must not be used";
  const whisper = new FakeWhisper(["transcribed here"]);
  h.onModel(() => ({ text: "Noted." }));
  await startMain({
    ...whisper.env,
    BRIDGE_GROQ_API_KEY: discord.groqKey,
    BRIDGE_GROQ_API_URL: discord.groqUrl,
  });

  voiceNote();
  assert.equal(userTexts(await h.waitForCall(0)).at(-1), "transcribed here");
  assert.deepEqual(discord.transcriptions, []);
});

async function assertUntranscribed(
  settings: (whisper: FakeWhisper) => Record<string, string>,
  why: RegExp,
): Promise<void> {
  const whisper = new FakeWhisper(["unused"]);
  h.onModel(() => ({ text: "Noted." }));
  const pi = await startMain({ ...whisper.env, ...settings(whisper) });

  voiceNote();
  const text = userTexts(await h.waitForCall(0)).at(-1) ?? "";
  const reference = new RegExp(
    `^\\[audio attachment: /.*${MEDIA.source} \\(transcription failed\\)\\]$`,
  );
  assert.match(text, reference);
  assert.match(await logged("transcription failed"), why);
  await assertSpoke(pi, "local", "failed");
}

test("a model file that is missing leaves the voice message as a file, and the log says so", async () => {
  await assertUntranscribed(
    () => ({ BRIDGE_WHISPER_MODEL: join(h.dir, "no-such-model.bin") }),
    /transcription failed: whisper-cli failed: error: model file not found '.*no-such-model\.bin'/,
  );
});

test("a whisper-cli that is not installed leaves the voice message as a file, and the log names it", async () => {
  await assertUntranscribed(
    () => ({ BRIDGE_WHISPER_CLI: join(h.dir, "no-such-whisper-cli") }),
    /transcription failed: no-such-whisper-cli is not installed or not on the PATH/,
  );
});

test("an ffmpeg that is not installed leaves the voice message as a file, and the log names it", async () => {
  await assertUntranscribed(
    () => ({ BRIDGE_FFMPEG: join(h.dir, "no-such-ffmpeg") }),
    /transcription failed: no-such-ffmpeg is not installed or not on the PATH/,
  );
});
