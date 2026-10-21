import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { quote } from "./host.ts";
import { REVIEW_LABEL, type Jobs } from "./jobs.ts";
import { lavishProblem } from "./prerequisites.ts";

const REVIEW_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const FEEDBACK = { tailLines: 5000, lineChars: 100_000 };

const ReviewParams = Type.Object({
  file: Type.String({ minLength: 1, description: "The HTML page for the captain to review" }),
  reply: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Your answer to the captain's last feedback, shown on the page: what you changed. Omit it on the first round",
    }),
  ),
});

function lavish(args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("lavish-axi", args, { encoding: "utf8", timeout: 60_000 }, (error, out, err) => {
      if (error === null) done(out);
      else fail(new Error(`lavish-axi ${args[0] ?? ""} failed: ${(out + err).trim()}`));
    });
  });
}

const withoutLavish = (problem: string): string =>
  `Lavish is not usable on this host, so no review page was opened and no review wait was started: ${problem}\n` +
  "Do not retry wait_review and do not run lavish-axi yourself. Write what the captain should review " +
  "as a plain Markdown report file outside your copy, such as /tmp/fleet-c-<N>/review.md (c-<N> is your card). " +
  "Then report needs-decision with a new key, or done if no answer is needed, naming the file's absolute path " +
  "and saying that lavish-axi is unavailable on this host.";

const field = (output: string, name: string): string | undefined =>
  new RegExp(`^\\s*${name}:\\s*"?([^"\\s]+)"?\\s*$`, "m").exec(output)?.[1];

async function open(page: string, browser: boolean): Promise<string> {
  const output = await lavish([page, ...(browser ? [] : ["--no-open"])]);
  if (field(output, "status") === "user-ended") {
    throw new Error(
      "The captain ended this review on the page. Do not open it again: finish your work and report.",
    );
  }
  const url = field(output, "url");
  if (url === undefined) throw new Error(`lavish-axi gave no link for ${page}: ${output.trim()}`);
  return url;
}

async function answer(page: string, reply: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-reply-"));
  const file = join(dir, "reply.md");
  try {
    writeFileSync(file, reply);
    await lavish(["reply", page, "--agent-reply-file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitOnPage(jobs: Jobs, file: string, reply?: string): Promise<string> {
  const problem = lavishProblem();
  if (problem !== undefined) throw new Error(withoutLavish(problem));
  if (jobs.reviewing) {
    throw new Error(
      "You already wait on the captain's review. His feedback arrives as a [fleet] message.",
    );
  }
  const page = resolve(file);
  if (reply !== undefined) await answer(page, reply);
  const url = await open(page, reply === undefined);
  const owner = `fleet-${basename(process.cwd())}`;
  const command = `lavish-axi poll ${quote(page)} --owner ${quote(owner)}`;
  const review = `The captain's review page waits for his feedback: ${url} (${page}). His feedback comes back to me.`;
  const { job, tab } = await jobs.launch(REVIEW_LABEL, command, {
    timeoutMs: REVIEW_TIMEOUT_MS,
    ...FEEDBACK,
    review,
  });
  return `The page is open for the captain at ${url}. Job ${String(job)} waits for his feedback in tab ${tab}, and the card waits on him. His feedback arrives as a [fleet] message; you may end this run.`;
}

export function registerReview(pi: ExtensionAPI, jobs: Jobs): void {
  jobs.waitOnPolledPages((page) => waitOnPage(jobs, page));
  pi.registerTool({
    name: "wait_review",
    label: "Wait for review",
    description:
      "Shows the captain an HTML page with Lavish and waits for his feedback in its own herdr tab. Returns at once: the card waits on the captain, and his feedback arrives later as a [fleet] message. Answer it, then call wait_review again with reply for the next round. Never run lavish-axi to open or poll a page yourself.",
    parameters: ReviewParams,
    execute: async (_id, { file, reply }) => {
      const text = await waitOnPage(jobs, file, reply);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
