import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { GrokReportArgs, check } from "@fleet/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { recordGrokReport } from "./grok-reports.ts";
import { hash } from "./store.ts";

export const GROK_REPORT_PATH = "/grok-report/mcp";
const REPORT_TOOL = "fleet_report_result";
const BODY_LIMIT = 128 * 1024;

function reportServer(db: DatabaseSync, notify: (recipient: string) => void): McpServer {
  const server = new McpServer(
    { name: "fleet-grok-report", version: "1.0.0" },
    {
      capabilities: { tools: {} },
    },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: REPORT_TOOL,
        description:
          "Record one result for a Fleet assignment and attempt. This does not settle the Bot turn or change the card status.",
        inputSchema: GrokReportArgs,
      },
    ],
  }));
  server.server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    if (params.name !== REPORT_TOOL) return toolReceipt({ receipt: "unknown-tool" });
    let args: GrokReportArgs;
    try {
      args = check(GrokReportArgs, params.arguments);
    } catch {
      return toolReceipt({ receipt: "invalid-result" });
    }
    const result = recordGrokReport(db, args);
    if (result.receipt !== "recorded") return toolReceipt(result);
    notify(result.recipient);
    return toolReceipt({ receipt: result.receipt, entry: result.entry });
  });
  return server;
}

function toolReceipt(result: { receipt: string; entry?: number }) {
  return {
    isError: result.receipt !== "recorded" && result.receipt !== "duplicate",
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

class ReportRefusal extends Error {
  readonly status: number;
  readonly code: number;

  constructor(status: number, code: number, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function refuse(response: ServerResponse, status: number, code: number, message: string): void {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function readReportBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tooLarge = new ReportRefusal(
      413,
      -32000,
      `Payload Too Large: Request body must not exceed ${String(BODY_LIMIT)} bytes`,
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) reject(tooLarge);
      else chunks.push(chunk);
    });
    request.on("end", () => {
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reject(new ReportRefusal(400, -32700, "Parse error: Invalid JSON"));
        return;
      }
      if (Array.isArray(message))
        reject(new ReportRefusal(400, -32600, "Invalid Request: Batches are not supported"));
      else resolve(message);
    });
    request.on("error", reject);
  });
}

export function grokReportEndpoint(db: DatabaseSync, notify: (recipient: string) => void) {
  const token = process.env["CARDD_GROK_REPORT_TOKEN"];
  if (token === undefined) return undefined;
  if (!/^grok\.[A-Za-z0-9_-]{32,}$/.test(token))
    throw new Error(
      "CARDD_GROK_REPORT_TOKEN must start with grok. followed by at least 32 URL-safe characters",
    );
  const expected = Buffer.from(hash(`Bearer ${token}`));
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const actual = Buffer.from(hash(request.headers.authorization ?? ""));
    if (!timingSafeEqual(actual, expected)) {
      response.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      refuse(response, 405, -32000, "Method not allowed.");
      return;
    }
    let body: unknown;
    try {
      body = await readReportBody(request);
    } catch (error) {
      if (error instanceof ReportRefusal) refuse(response, error.status, error.code, error.message);
      else response.destroy();
      return;
    }
    const server = reportServer(db, notify);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await server.close();
    }
  };
}
