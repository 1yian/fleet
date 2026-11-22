import { request } from "node:http";
import { AxiError } from "axi-sdk-js";
import type { DirectLogin } from "../shared/direct-login.js";
import type { Handoff, LaneSnapshot } from "../shared/protocol.js";

export const DAEMON_URL = process.env.FLEET_BROWSER_URL ?? "http://127.0.0.1:7620";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${DAEMON_URL}${path}`, init);
  } catch {
    throw new AxiError(`the fleet-browser service is not reachable at ${DAEMON_URL}`, "SERVICE_DOWN", [
      "Run `systemctl status fleet-browser` on the browser host",
      "Set FLEET_BROWSER_URL if the service listens elsewhere",
    ]);
  }
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new AxiError(body.error ?? `service answered ${response.status}`, "SERVICE_ERROR");
  return body;
}

export async function postDirectLogin<T>(delivery: DirectLogin): Promise<T> {
  const failed = () =>
    new AxiError("could not deliver credentials to the local browser service", "DIRECT_LOGIN_FAILED");
  let endpoint: URL;
  try {
    endpoint = new URL(DAEMON_URL);
  } catch {
    throw failed();
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.origin !== DAEMON_URL.replace(/\/$/, "")
  ) {
    throw new AxiError(
      "direct login requires a literal loopback browser service URL",
      "DIRECT_LOGIN_NOT_LOCAL",
    );
  }
  return new Promise<T>((resolve, reject) => {
    const body = JSON.stringify({ direct: delivery });
    const req = request(
      new URL(`/v1/lanes/${delivery.lane}/login`, endpoint),
      {
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(failed());
          return;
        }
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.length > 4096) req.destroy(failed());
        });
        res.on("error", () => reject(failed()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(failed());
          }
        });
      },
    );
    req.setTimeout(60_000, () => req.destroy(failed()));
    req.on("error", () => reject(failed()));
    req.end(body);
  });
}

export const daemon = {
  snapshot: (lane: string) => call<LaneSnapshot>(`/v1/lanes/${lane}`),
  start: (lane: string) => call<LaneSnapshot>(`/v1/lanes/${lane}/start`, { method: "POST" }),
  stop: (lane: string) => call<LaneSnapshot>(`/v1/lanes/${lane}/stop`, { method: "POST" }),
  restart: (lane: string) => call<LaneSnapshot>(`/v1/lanes/${lane}/restart`, { method: "POST" }),
  openHandoff: (lane: string, reason: string, waitSeconds: number, target?: string) =>
    call<Handoff>(`/v1/lanes/${lane}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason, waitSeconds, target }),
    }),
  post: <T>(lane: string, action: string, body: Record<string, unknown>) =>
    call<T>(`/v1/lanes/${lane}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  get: <T>(lane: string, action: string) => call<T>(`/v1/lanes/${lane}/${action}`),
  currentHandoff: (lane: string) => call<Handoff | null>(`/v1/lanes/${lane}/handoff`),
  waitHandoff: (lane: string, id: string, timeoutSeconds: number) =>
    call<Handoff>(`/v1/lanes/${lane}/handoff/${id}/wait?timeout=${timeoutSeconds}`),
  cancelHandoff: (lane: string, id: string) =>
    call<Handoff>(`/v1/lanes/${lane}/handoff/${id}/cancel`, { method: "POST" }),
};
