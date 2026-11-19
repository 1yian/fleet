import { randomUUID } from "node:crypto";
import { check } from "@fleet/protocol";
import Type from "typebox";
import { lavishRequest, type ReviewSession } from "./review-session.ts";

const Annotations = Type.Array(
  Type.Object(
    {
      prompt: Type.String({ pattern: "\\S", maxLength: 4000 }),
      selector: Type.String({ maxLength: 2000 }),
      tag: Type.String({ pattern: "^(?!layout-warnings$)", maxLength: 100 }),
      uid: Type.String({ maxLength: 200 }),
      text: Type.String({ maxLength: 1000 }),
      target: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    },
    { additionalProperties: false },
  ),
  { maxItems: 30 },
);

function draftFits(annotations: unknown[], max: number): boolean {
  const limits: Record<string, number> = {
    prompt: 4000,
    selector: 2000,
    tag: 100,
    uid: 200,
    text: 1000,
  };
  const shape = (note: object): boolean =>
    Object.entries(limits).every(([key, limit]) => {
      const value: unknown = Reflect.get(note, key);
      return typeof value === "string" && value.length <= limit;
    });
  const target = (note: object): boolean => {
    const value: unknown = Reflect.get(note, "target");
    return (
      value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value))
    );
  };
  const one = (note: unknown): boolean =>
    note !== null &&
    typeof note === "object" &&
    shape(note) &&
    target(note) &&
    /\S/.test(String(Reflect.get(note, "prompt"))) &&
    Reflect.get(note, "tag") !== "layout-warnings" &&
    JSON.stringify(note).length <= 8000;
  return (
    annotations.length <= 30 &&
    annotations.every(one) &&
    new URLSearchParams({ annotations: JSON.stringify(annotations) }).toString().length <= max
  );
}

export const REVIEW_BODY_LIMIT = 125000;
const ANNOTATION_LIMIT = REVIEW_BODY_LIMIT - 25000;

export function reviewFeedback(form: URLSearchParams) {
  const words = form.get("words");
  const annotations = check(Annotations, JSON.parse(form.get("annotations") ?? "[]"));
  if (words === null || words.length > 2000 || !draftFits(annotations, ANNOTATION_LIMIT))
    throw new Error("review feedback is missing or too long");
  return { words, annotations };
}

const Chrome = Type.Object({ chrome_load_token: Type.String({ minLength: 1, maxLength: 512 }) });
const Artifact = Type.Object({
  artifact_load_token: Type.String({ minLength: 1, maxLength: 512 }),
  artifact_revision: Type.Integer({ minimum: 0 }),
});

function lavishPost(session: URL, action: string, body: object): Promise<Response> {
  const key = session.pathname.split("/").at(-1) ?? "";
  return lavishRequest(new URL(`/api/${key}/${action}`, session), body);
}

async function reviewLoad(session: URL, action: string, body: object): Promise<unknown> {
  const response = await lavishPost(session, action, body);
  if (response.ok) return response.json();
  await response.body?.cancel();
  throw new Error("Lavish could not open the review; answer on the board");
}

export async function reviewPage(
  owned: ReviewSession,
  origin: URL,
): Promise<{ html: string; headers: Record<string, string> }> {
  const session = owned.url;
  const chrome = check(Chrome, await reviewLoad(session, "chrome-loads/begin", {}));
  const binding = check(
    Artifact,
    await reviewLoad(session, "artifact-loads/begin", {
      request_id: randomUUID(),
      request_sequence: 1,
      chrome_load_token: chrome.chrome_load_token,
    }),
  );
  const artifact = new URL(`/review-artifact/${owned.token}`, origin);
  artifact.search = new URLSearchParams({
    artifact_load_token: binding.artifact_load_token,
    artifact_revision: String(binding.artifact_revision),
  }).toString();
  const attribute = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const nonce = randomUUID();
  return {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; frame-src ${origin.origin}; frame-ancestors 'none'; connect-src 'self'; form-action 'none'; style-src 'unsafe-inline'`,
    },
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fleet review</title>
<style>body{font:1rem system-ui;margin:1rem auto;padding:0 1rem;max-width:100rem}iframe{border:1px solid #888;width:100%;height:65vh}textarea{display:block;box-sizing:border-box;width:100%;min-height:5rem;margin:.5rem 0}button{font:inherit;padding:.4rem .8rem}li{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>Review</h1><label><input id="annotate" type="checkbox" checked> Annotate</label>
<p>Uncheck Annotate to interact with the page. Queue each annotation in the artifact, then confirm the list below. For image attachments, use Lavish directly and answer separately on the board.</p>
<iframe id="artifact" title="Review artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" data-token="${attribute(binding.artifact_load_token)}" data-source="${attribute(artifact.href)}"></iframe>
<form method="post"><h2>Queued annotations</h2><ul id="queue" aria-live="polite"></ul><p id="notice" role="status"></p><input name="session" type="hidden" value="${owned.token}"><input id="annotations" name="annotations" type="hidden" value="[]"><label for="words">Feedback</label><textarea id="words" name="words" maxlength="2000"></textarea><button id="send" type="submit" disabled>Send &amp; End</button></form><p><a href="/">Back to Fleet board</a></p>
<script nonce="${nonce}">${reviewScript}</script></html>`,
  };
}

const reviewScript = `
const frame = document.querySelector('#artifact');
const annotate = document.querySelector('#annotate');
const queue = document.querySelector('#queue');
const notice = document.querySelector('#notice');
const field = document.querySelector('#annotations');
const form = document.querySelector('form');
const feedback = form.elements.words;
const send = document.querySelector('#send');
const draftFits = ${draftFits.toString()};
const drafts = [];
const rejected = [];
const late = [];
let sending = false;
let ended = false;
function mode() {
  frame.contentWindow.postMessage({ type: 'lavish:setAnnotationMode', enabled: annotate.checked && !sending }, '*');
}
function freeze(on) {
  sending = on;
  feedback.readOnly = on;
  annotate.disabled = on;
  frame.inert = on;
  mode();
  update();
}
function item(text, label, drop) {
  const row = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.disabled = sending;
  button.onclick = drop;
  row.append(text + ' ', button);
  return row;
}
function update() {
  field.value = JSON.stringify(drafts.map(({ prompt }) => prompt));
  send.disabled = sending || ended || rejected.length > 0;
  queue.replaceChildren(
    ...drafts.map(({ prompt }, index) =>
      item((prompt.text ? prompt.text + ': ' : '') + prompt.prompt, 'Remove', () => { drafts.splice(index, 1); update(); })),
    ...rejected.map((text, index) =>
      item('Cannot send this annotation: ' + text, 'Discard rejected annotation', () => { rejected.splice(index, 1); update(); })),
  );
}
function accept(prompt) {
  try {
    const { prompt: words, selector, tag, uid, text, target, attachments, _lavishQueueKey: key } = prompt;
    const note = { prompt: words, selector, tag, uid, text, ...(target === undefined ? {} : { target }) };
    const at = typeof key === 'string' && key ? drafts.findIndex((draft) => draft.key === key) : -1;
    const next = drafts.map((draft) => draft.prompt);
    next.splice(at < 0 ? next.length : at, at < 0 ? 0 : 1, note);
    if (attachments?.length || !draftFits(next, ${String(ANNOTATION_LIMIT)})) throw new Error();
    drafts.splice(at < 0 ? drafts.length : at, at < 0 ? 0 : 1, { key, prompt: note });
    notice.textContent = 'Annotation queued. Confirm the feedback below.';
  } catch {
    rejected.push(typeof prompt?.prompt === 'string' ? prompt.prompt : 'Invalid annotation');
    notice.textContent = 'Discard the rejected draft or answer on the board.';
  }
  update();
}
annotate.addEventListener('change', mode);
frame.addEventListener('load', mode);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || ended || rejected.length) return;
  const body = new URLSearchParams(new FormData(form));
  if (body.toString().length > ${String(REVIEW_BODY_LIMIT)}) {
    notice.textContent = 'Feedback is too large. Remove a draft or shorten your feedback.';
    return;
  }
  freeze(true);
  try {
    const result = await fetch(location.href, { method: 'POST', body, redirect: 'error' });
    if (result.status === 204) {
      ended = true;
      if (!late.length) { location.assign('/'); return; }
      notice.textContent = 'The review ended. These annotations arrived while sending and were not delivered; copy them before leaving.';
      rejected.push(...late.splice(0).map((each) => String(each?.prompt ?? 'Invalid annotation')));
      freeze(false);
      return;
    }
    const refusal = await result.json();
    notice.textContent = refusal.error || 'Could not send review feedback.';
  } catch {
    notice.textContent = 'Could not send review feedback. Your draft is still here.';
  }
  freeze(false);
  for (const prompt of late.splice(0)) accept(prompt);
});
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (event.source !== frame.contentWindow || event.origin !== 'null' ||
      !msg || msg.artifact_load_token !== frame.dataset.token) return;
  if (msg.type === 'lavish:toggleAnnotationMode' && !sending) {
    annotate.checked = !annotate.checked;
    mode();
  }
  if (msg.type === 'lavish:uploadAttachment') {
    const error = 'Images are only supported in direct Lavish. Remove the image to queue here.';
    if (!sending) { rejected.push(error); update(); }
    event.source.postMessage({ type: 'lavish:attachmentResult', nonce: msg.nonce,
      localId: msg.localId, ok: false, error }, '*');
  }
  if (msg.type === 'lavish:sendQueuedPrompts') notice.textContent = 'Confirm the queue with Send & End below.';
  if (msg.type !== 'lavish:queuePrompt') return;
  if (sending) late.push(msg.prompt);
  else accept(msg.prompt);
});
update();
frame.src = frame.dataset.source;
`;

export async function sendAndEnd(
  session: URL,
  { words, annotations }: ReturnType<typeof reviewFeedback>,
): Promise<boolean> {
  const response = await lavishPost(session, "prompts", {
    endSession: true,
    prompts: [...annotations, ...(words.trim() === "" ? [] : [{ tag: "message", prompt: words }])],
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    return false;
  }
  const result: unknown = await response.json();
  return (
    typeof result === "object" && result !== null && Reflect.get(result, "status") === "queued"
  );
}
