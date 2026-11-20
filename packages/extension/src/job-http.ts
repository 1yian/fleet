import { check, HttpOutcomeSchema, type OpArgs } from "@fleet/protocol";

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
  if (!outcome.ok) return { ...outcome, status: response.status };
  if (response.status !== 200)
    throw new Error(`Unexpected response to ${op}: ${String(response.status)}`);
  return outcome;
}
