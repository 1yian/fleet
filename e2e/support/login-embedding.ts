import { Cdp } from "@fleet/protocol";
import type { BrowserLab, RawWorker } from "./browser-lab.ts";
import { isRecord, records } from "./json.ts";

export type Embedding = "document" | "shadow" | "closed-shadow" | "frame" | "cross-frame";

export interface Login {
  readonly fields: string;
  readonly inChrome: (expression: string) => Promise<unknown>;
}

const OTHER_SITE = "login.example.test";

async function inFrame(lab: BrowserLab, expression: string): Promise<unknown> {
  const cdp = await Cdp.connect(lab.chrome.endpoint);
  try {
    const listed = await cdp.send("Target.getTargets");
    if (!isRecord(listed)) throw new Error("Chrome did not list its targets");
    const frame = records(listed["targetInfos"]).find(
      (each) => each["type"] === "iframe" && each["url"] === lab.site.url("/entry", OTHER_SITE),
    );
    const id = frame?.["targetId"];
    return typeof id === "string" ? await lab.chrome.evaluate(id, expression) : undefined;
  } finally {
    cdp.close();
  }
}

async function inTab(
  lab: BrowserLab,
  worker: RawWorker,
  fields: string,
  expression: string,
): Promise<unknown> {
  const tab = (await lab.chrome.pages()).find((each) =>
    each.title.startsWith(`c-${String(worker.card.id)} `),
  );
  return tab === undefined
    ? undefined
    : lab.chrome
        .evaluate(tab.id, expression.replaceAll("document.", `${fields}.`))
        .catch(() => undefined);
}

export async function embedLogin(
  lab: BrowserLab,
  worker: RawWorker,
  embedding: Embedding,
): Promise<Login> {
  let fields = "document";
  if (embedding === "shadow" || embedding === "closed-shadow") {
    const closed = embedding === "closed-shadow";
    await worker.act({
      action: "eval",
      expression: `(() => {
        const host = document.createElement("div");
        host.id = "host";
        document.body.append(host);
        const root = host.attachShadow({ mode: ${JSON.stringify(closed ? "closed" : "open")} });
        window.fixtureRoot = root;
        const form = document.querySelector("form");
        ${closed ? "root.innerHTML = form.outerHTML; form.remove();" : "root.append(form);"}
      })()`,
    });
    fields = "window.fixtureRoot";
  }
  const crossFrame = embedding === "cross-frame";
  if (embedding === "frame" || crossFrame) {
    await worker.act({
      action: "eval",
      expression: `new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.id = "inner";
        frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
        frame.onload = () => resolve("ready");
        ${crossFrame ? `frame.src = ${JSON.stringify(lab.site.url("/entry", OTHER_SITE))};` : 'frame.srcdoc = document.querySelector("form").outerHTML;'}
        document.querySelector("form").remove();
        document.body.append(frame);
      })`,
    });
    fields = 'document.getElementById("inner").contentDocument';
  }
  return {
    fields,
    inChrome: (expression) =>
      crossFrame ? inFrame(lab, expression) : inTab(lab, worker, fields, expression),
  };
}
