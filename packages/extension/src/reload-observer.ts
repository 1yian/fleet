import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { check, HttpOutcomeSchema, MaintenanceSchema } from "@fleet/protocol";
import Type, { type Static } from "typebox";
import { scrub } from "./host.ts";
import { hostDir } from "./scratch.ts";

const ReceiptSchema = Type.Object({
  url: Type.String(),
  token: Type.String(),
  id: Type.Integer(),
});
export type ReloadReceipt = Static<typeof ReceiptSchema>;

const receipt = (): ReloadReceipt | undefined => {
  const text = process.env["FLEET_RELAUNCH_REPORT"];
  return text === undefined || text === "" ? undefined : check(ReceiptSchema, JSON.parse(text));
};

const redacted = (text: string, token: string | undefined): string =>
  scrub(text, token === undefined ? [] : [token])
    .replace(/Bearer\s+\S+/gi, "Bearer [hidden]")
    .replace(
      /\b(api[-_ ]?key|token|secret|password|authorization)(["']?\s*[:=]\s*)["']?[^\s"',;]+/gi,
      "$1$2[hidden]",
    )
    .replace(/\b(?:sk|pk|xai|gsk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{8,}/g, "[hidden]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[hidden]")
    .replace(/\s+/g, " ")
    .slice(0, 1000);

async function call(report: ReloadReceipt, op: string, args: object) {
  const url = report.url.replace(/^ws/, "http").replace(/\/session$/, "/call");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${report.token}`, "content-type": "application/json" },
    body: JSON.stringify({ op, args }),
    signal: AbortSignal.timeout(5000),
  });
  const outcome = check(HttpOutcomeSchema, await response.json());
  if (!outcome.ok) throw new Error(outcome.error);
  return check(MaintenanceSchema, outcome.value);
}

async function verified(report: ReloadReceipt): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const row = await call(report, "maintenance.read", { id: report.id });
    if (row.state === "completed") return;
    if (row.state === "failed") throw new Error(row.detail);
    if (Date.now() >= deadline) throw new Error("no replacement hello within 60 seconds");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function observeReload(
  identity: { readonly pid: number; readonly pane: string; readonly home: string },
  work: () => Promise<void>,
): Promise<void> {
  const file = join(hostDir(), "logs", "reloads.jsonl");
  mkdirSync(join(hostDir(), "logs"), { recursive: true, mode: 0o700 });
  let report: ReloadReceipt | undefined;
  let startedAt: number | null = null;
  const log = (event: string, detail: string): void => {
    const row = {
      at: new Date().toISOString(),
      event,
      ...identity,
      helperPid: process.pid,
      startedAt,
      maintenance: report?.id ?? null,
      detail: redacted(detail, report?.token),
    };
    appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  };
  try {
    const at = process.env["FLEET_RELAUNCH_STARTED_AT"];
    if (at !== undefined && at !== "") startedAt = check(Type.Integer({ minimum: 0 }), Number(at));
    report = receipt();
    log("start", "waiting for the old process to exit");
    await work();
    if (report !== undefined) await verified(report);
    log(
      "success",
      report === undefined
        ? "command submitted; no maintenance receipt"
        : "replacement hello verified",
    );
  } catch (error) {
    const detail = redacted(error instanceof Error ? error.message : String(error), report?.token);
    log("error", detail);
    if (report !== undefined)
      await call(report, "maintenance.ack", { id: report.id, state: "failed", detail }).catch(
        (error: unknown) => {
          log("report-error", error instanceof Error ? error.message : String(error));
        },
      );
    process.exitCode = 1;
  }
}
