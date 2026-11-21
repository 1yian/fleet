import { check, HttpOutcomeSchema, OPS, type OpArgs } from "@fleet/protocol";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

interface JobEndpoint {
  readonly url: string;
  readonly token: string;
}

export async function jobHandshake<N extends "job.prepare" | "job.register">(
  endpoint: JobEndpoint,
  op: N,
  args: OpArgs<N>,
): Promise<{ ok: false; error: string; status: number } | { ok: true; value: unknown }> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify({ op, args }),
    signal: AbortSignal.timeout(5000),
  });
  const outcome = check(HttpOutcomeSchema, await response.json());
  if (!outcome.ok) {
    if (outcome.retryable === true || response.status >= 500) throw new Error(outcome.error);
    return { ...outcome, status: response.status };
  }
  if (response.status !== 200)
    throw new Error(`Unexpected response to ${op}: ${String(response.status)}`);
  return outcome;
}

export async function confirmLegacyStop(
  endpoint: JobEndpoint,
  job: number,
  label: string,
): Promise<boolean> {
  const secure = new URL(endpoint.url).protocol === "https:";
  const agent = new (secure ? HttpsAgent : HttpAgent)({ keepAlive: true, maxSockets: 1 });
  const request = secure ? httpsRequest : httpRequest;
  const signal = AbortSignal.timeout(5000);
  let connection: Socket | undefined;
  const call = async (op: string, args: object) => {
    const { status, text } = await new Promise<{ status: number | undefined; text: string }>(
      (resolve, reject) => {
        const req = request(
          endpoint.url,
          {
            agent,
            signal,
            method: "POST",
            headers: {
              authorization: `Bearer ${endpoint.token}`,
              "content-type": "application/json",
            },
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8").on("data", (chunk: string) => {
              text += chunk;
            });
            response.once("error", reject);
            response.once("end", () => resolve({ status: response.statusCode, text }));
          },
        );
        req.once("error", reject);
        req.once("socket", (socket: Socket) => {
          if (connection !== undefined && connection !== socket) {
            req.destroy(new Error("cardd's connection changed before stop authorization"));
            return;
          }
          connection = socket;
          req.end(JSON.stringify({ op, args }));
        });
      },
    );
    return { status, outcome: check(HttpOutcomeSchema, JSON.parse(text)) };
  };
  try {
    const probe = await call("job.cutover", { action: "status" });
    if (
      probe.status !== 400 ||
      probe.outcome.ok ||
      probe.outcome.retryable === true ||
      probe.outcome.error !== "unknown operation job.cutover"
    )
      return false;
    const stop = await call("job.stop", { job });
    if (stop.status !== 200 || !stop.outcome.ok) return false;
    const receipt = check(OPS["job.stop"].result, stop.outcome.value);
    return receipt.running && receipt.label === label;
  } catch {
    return false;
  } finally {
    agent.destroy();
  }
}
