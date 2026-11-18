import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { check } from "@fleet/protocol";
import Type from "typebox";

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
  const source = artifact.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "same-origin",
    "content-security-policy": `default-src 'none'; frame-src ${session.origin}; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'`,
  })
    .end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fleet review</title>
<style>body{font:1rem system-ui;margin:1rem auto;padding:0 1rem;max-width:100rem}iframe{border:1px solid #888;width:100%;height:65vh}textarea{display:block;box-sizing:border-box;width:100%;min-height:5rem;margin:.5rem 0}button{font:inherit;padding:.4rem .8rem}</style>
<h1>Review</h1><iframe title="Review artifact" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${source}"></iframe>
<form method="post"><label for="words">Feedback</label><textarea id="words" name="words" maxlength="2000"></textarea><button type="submit">Send &amp; End</button></form><p><a href="/">Back to Fleet board</a></p></html>`);
}

export async function sendAndEnd(session: URL, words: string): Promise<boolean> {
  const response = await lavishPost(session, "prompts", {
    endSession: true,
    prompts: words.trim() === "" ? [] : [{ tag: "message", prompt: words }],
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
