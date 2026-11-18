import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { check } from "@fleet/protocol";
import Type from "typebox";

const Chrome = Type.Object({ chrome_load_token: Type.String({ minLength: 1, maxLength: 512 }) });
const Artifact = Type.Object({
  artifact_load_token: Type.String({ minLength: 1, maxLength: 512 }),
  artifact_revision: Type.Integer({ minimum: 0 }),
});

async function reviewLoad(session: URL, action: string, body: object): Promise<unknown> {
  const key = session.pathname.split("/").at(-1) ?? "";
  const response = await fetch(new URL(`/api/${key}/${action}`, session), {
    method: "POST",
    headers: { "content-type": "application/json", origin: session.origin },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) return response.json();
  await response.body?.cancel();
  throw new Error("Lavish could not open the preview; answer on the board");
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
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; frame-src ${session.origin}; frame-ancestors 'none'; form-action 'none'; style-src 'unsafe-inline'`,
  })
    .end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fleet review preview</title>
<style>body{font:1rem system-ui;margin:1rem auto;padding:0 1rem;max-width:100rem}iframe{border:1px solid #888;width:100%;height:65vh}button{font:inherit;padding:.4rem .8rem}li{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h1>Review preview</h1>
<p>This preview shows the current artifact at the Lavish link. Lavish can reopen a session at the same link, so Fleet cannot safely complete this review here, with or without notes.</p>
<p>Draft annotations below stay in this tab. Copy anything you want to send before leaving. Use Lavish directly to send feedback or images, then <a href="/">answer on the Fleet board</a>.</p>
<label><input id="annotate" type="checkbox" checked> Annotate</label>
<p>Uncheck Annotate to interact with the artifact without sending.</p>
<iframe id="artifact" title="Review artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" data-token="${attribute(binding.artifact_load_token)}" data-source="${attribute(artifact.href)}"></iframe>
<h2>Local annotation drafts</h2><ul id="queue" aria-live="polite"></ul><p id="notice" role="status"></p>
<script nonce="${nonce}">${reviewScript}</script></html>`);
}

const reviewScript = `
const frame = document.querySelector('#artifact');
const annotate = document.querySelector('#annotate');
const queue = document.querySelector('#queue');
const notice = document.querySelector('#notice');
function mode() {
  frame.contentWindow.postMessage({ type: 'lavish:setAnnotationMode', enabled: annotate.checked }, '*');
}
annotate.addEventListener('change', mode);
frame.addEventListener('load', mode);
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (event.source !== frame.contentWindow || event.origin !== 'null' ||
      !msg || msg.artifact_load_token !== frame.dataset.token) return;
  if (msg.type === 'lavish:toggleAnnotationMode') {
    annotate.checked = !annotate.checked;
    mode();
  }
  if (msg.type === 'lavish:uploadAttachment') {
    const error = 'Images are only supported in direct Lavish. Remove the image to keep the text draft here.';
    event.source.postMessage({ type: 'lavish:attachmentResult', nonce: msg.nonce,
      localId: msg.localId, ok: false, error }, '*');
  }
  if (msg.type === 'lavish:sendQueuedPrompts' || msg.type === 'lavish:endSession')
    notice.textContent = 'This preview cannot send or end the review.';
  if (msg.type !== 'lavish:queuePrompt' || typeof msg.prompt?.prompt !== 'string') return;
  const { prompt, text } = msg.prompt;
  const item = document.createElement('li');
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.textContent = 'Discard draft';
  discard.onclick = () => item.remove();
  item.append((typeof text === 'string' && text ? text + ': ' : '') + prompt + ' ', discard);
  queue.append(item);
});
frame.src = frame.dataset.source;
`;
