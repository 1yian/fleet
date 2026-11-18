import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { check } from "@fleet/protocol";
import Type from "typebox";

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

export function reviewFeedback(form: URLSearchParams) {
  const words = form.get("words");
  const annotations = check(Annotations, JSON.parse(form.get("annotations") ?? "[]"));
  if (words === null || words.length > 2000 || (words.trim() === "" && annotations.length === 0))
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
  return fetch(new URL(`/api/${key}/${action}`, session), {
    method: "POST",
    headers: { "content-type": "application/json", origin: session.origin },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

async function reviewLoad(session: URL, action: string, body: object): Promise<unknown> {
  const response = await lavishPost(session, action, body);
  if (response.ok) return response.json();
  await response.body?.cancel();
  throw new Error("Lavish could not open the review; answer on the board");
}

export async function reviewPage(response: ServerResponse, session: URL): Promise<void> {
  const chrome = check(Chrome, await reviewLoad(session, "chrome-loads/begin", {}));
  const binding = check(
    Artifact,
    await reviewLoad(session, "artifact-loads/begin", {
      request_id: randomUUID(),
      request_sequence: 1,
      chrome_load_token: chrome.chrome_load_token,
    }),
  );
  const artifact = new URL(
    session.pathname.replace(/^\/session\//, "/artifact/") + "/index.html",
    session,
  );
  artifact.search = new URLSearchParams({
    artifact_load_token: binding.artifact_load_token,
    artifact_revision: String(binding.artifact_revision),
  }).toString();
  const attribute = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const nonce = randomUUID();
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "same-origin",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; frame-src ${session.origin}; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'`,
  })
    .end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fleet review</title>
<style>body{font:1rem system-ui;margin:1rem auto;padding:0 1rem;max-width:100rem}iframe{border:1px solid #888;width:100%;height:65vh}textarea{display:block;box-sizing:border-box;width:100%;min-height:5rem;margin:.5rem 0}button{font:inherit;padding:.4rem .8rem}li{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>Review</h1><label><input id="annotate" type="checkbox" checked> Annotate</label>
<p>Uncheck Annotate to interact with the page. Queue each annotation in the artifact, then confirm the list below. For image attachments, use Lavish directly and answer separately on the board.</p>
<iframe id="artifact" title="Review artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" data-token="${attribute(binding.artifact_load_token)}" data-source="${attribute(artifact.href)}"></iframe>
<form method="post"><h2>Queued annotations</h2><ul id="queue" aria-live="polite"></ul><p id="notice" role="status"></p><input id="annotations" name="annotations" type="hidden" value="[]"><label for="words">Feedback</label><textarea id="words" name="words" maxlength="2000"></textarea><button id="send" type="submit" disabled>Send &amp; End</button></form><p><a href="/">Back to Fleet board</a></p>
<script nonce="${nonce}">${reviewScript}</script></html>`);
}

const reviewScript = `
const frame = document.querySelector('#artifact');
const annotate = document.querySelector('#annotate');
const queue = document.querySelector('#queue');
const notice = document.querySelector('#notice');
const field = document.querySelector('#annotations');
const words = document.querySelector('#words');
const send = document.querySelector('#send');
const drafts = [];
function mode() {
  frame.contentWindow.postMessage({ type: 'lavish:setAnnotationMode', enabled: annotate.checked }, '*');
}
function update() {
  field.value = JSON.stringify(drafts.map(({ prompt }) => prompt));
  send.disabled = drafts.length === 0 && words.value.trim() === '';
  queue.replaceChildren(...drafts.map(({ prompt }, index) => {
    const item = document.createElement('li');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.onclick = () => { drafts.splice(index, 1); update(); };
    item.append((prompt.text ? prompt.text + ': ' : '') + prompt.prompt + ' ', remove);
    return item;
  }));
}
annotate.addEventListener('change', mode);
frame.addEventListener('load', mode);
words.addEventListener('input', update);
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (event.source !== frame.contentWindow || event.origin !== 'null' ||
      !msg || msg.artifact_load_token !== frame.dataset.token) return;
  if (msg.type === 'lavish:toggleAnnotationMode') {
    annotate.checked = !annotate.checked;
    mode();
  }
  if (msg.type === 'lavish:uploadAttachment') {
    const error = 'Images are only supported in direct Lavish. Remove the image to queue here.';
    event.source.postMessage({ type: 'lavish:attachmentResult', nonce: msg.nonce,
      localId: msg.localId, ok: false, error }, '*');
  }
  if (msg.type === 'lavish:sendQueuedPrompts') notice.textContent = 'Confirm the queue with Send & End below.';
  if (msg.type !== 'lavish:queuePrompt') return;
  try {
    const { prompt, selector, tag, uid, text, target, attachments, _lavishQueueKey: key } = msg.prompt;
    const note = { prompt, selector, tag, uid, text, ...(target ? { target } : {}) };
    const at = typeof key === 'string' && key ? drafts.findIndex((draft) => draft.key === key) : -1;
    if (![prompt, selector, tag, uid, text].every((value) => typeof value === 'string') ||
        !prompt.trim() || prompt.length > 4000 || selector.length > 2000 || tag.length > 100 ||
        tag === 'layout-warnings' || uid.length > 200 || text.length > 1000 || attachments?.length ||
        (at < 0 && drafts.length >= 30) || JSON.stringify(note).length > 8000) throw new Error();
    const next = drafts.map((draft) => draft.prompt);
    next.splice(at < 0 ? next.length : at, at < 0 ? 0 : 1, note);
    if (encodeURIComponent(JSON.stringify(next)).length > 90000) throw new Error();
    drafts.splice(at < 0 ? drafts.length : at, at < 0 ? 0 : 1, { key, prompt: note });
    notice.textContent = 'Annotation queued. Confirm the feedback below.';
    update();
  } catch {
    notice.textContent = 'An annotation could not be queued. Use direct Lavish and the board fallback if needed.';
  }
});
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
