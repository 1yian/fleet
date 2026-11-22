import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { check, OPS, type Card } from "@fleet/protocol";
import type { Fleet } from "./fleet.ts";

export const TOKEN = `grok.${randomUUID().replaceAll("-", "")}`;
export const VERSION = "2025-11-25";

export function rpc(
  started: Fleet,
  method: string,
  params: unknown,
  token: string | null = TOKEN,
  id: number | null = 1,
): Promise<Response> {
  const url = started.cardd.url.replace(/^ws/, "http").replace(/\/session$/, "/grok-report/mcp");
  return fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": VERSION,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === null ? {} : { id }),
      method,
      params,
    }),
  });
}

export const assign = async (started: Fleet, card: Card, assignment?: string) =>
  check(
    OPS["grok.assign"].result,
    await started.main.call("grok.assign", { card: card.id, assignment }),
  );

export async function tool(
  started: Fleet,
  args: unknown,
  name = "fleet_report_result",
): Promise<unknown> {
  const response = await rpc(started, "tools/call", { name, arguments: args });
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  assert.ok(typeof payload === "object" && payload !== null && "result" in payload);
  const result = payload.result;
  assert.ok(typeof result === "object" && result !== null && "structuredContent" in result);
  return {
    receipt: result.structuredContent,
    isError: "isError" in result && result.isError,
  };
}

export const receipt = (status: string, entry?: number) => ({
  receipt: { receipt: status, ...(entry === undefined ? {} : { entry }) },
  isError: status !== "recorded" && status !== "duplicate",
});
export const view = async (started: Fleet, card: Card) =>
  check(OPS.card.result, await started.main.call("card", { card: card.id }));
