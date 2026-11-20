import { AxiError } from "axi-sdk-js";
import { ownTab } from "./browser.js";
import { daemon } from "./client.js";
import { askCaptain } from "./handoff.js";

interface CaptchaResult {
  outcome: string;
  kind?: string;
  reason?: string;
  seconds?: number;
  captchas?: Array<{ kind: string; visible: boolean }>;
  model?: { calls?: number; prompt_tokens?: number; completion_tokens?: number };
  [key: string]: unknown;
}

function summarize(result: CaptchaResult) {
  return {
    captcha: result.outcome,
    ...(result.kind ? { kind: result.kind } : {}),
    ...(result.seconds !== undefined ? { seconds: result.seconds } : {}),
    ...(result.model?.calls ? { model_calls: result.model.calls } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export async function captchaCommand(lane: string, args: string[]) {
  const rest = [...args];
  const noHandoff = rest.includes("--no-handoff");
  if (noHandoff) rest.splice(rest.indexOf("--no-handoff"), 1);
  const detect = rest[0] === "detect";
  const kindAt = rest.indexOf("--kind");
  const kind = kindAt === -1 ? "auto" : (rest[kindAt + 1] ?? "");
  if (!["auto", "hcaptcha", "recaptcha", "turnstile"].includes(kind)) {
    throw new AxiError("kind must be hcaptcha, recaptcha or turnstile", "BAD_CAPTCHA_KIND", [
      "Run `fleet-browser captcha`",
    ]);
  }
  const target = await ownTab(lane);
  const result = await daemon.post<CaptchaResult>(lane, "captcha", { kind, detect, target });
  if (detect) {
    return {
      captchas: (result.captchas ?? []).map((c) => `${c.kind}${c.visible ? " (visible)" : " (hidden)"}`),
      help: ["Run `fleet-browser captcha` to solve the visible one"],
    };
  }
  if (result.outcome === "solved") {
    return { ...summarize(result), help: ["Continue the page flow with `fleet-browser snapshot -i`"] };
  }
  if (result.outcome === "none") {
    return {
      ...summarize(result),
      help: ["No captcha is visible; run `fleet-browser snapshot -i`"],
    };
  }
  if (noHandoff) return summarize(result);
  const why = result.reason ? `: ${result.reason}` : "";
  const handoff = await askCaptain(
    lane,
    `captcha could not be solved automatically${why}. Please solve it on the page`,
    1800,
    target,
  );
  return { ...summarize(result), ...handoff };
}
