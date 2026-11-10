import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isRecord, parseRecord } from "./json.ts";

export type Vintage = "no-build" | "old-build";

const OLD_BUILD = "0123456789ab";

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

function spoken(vintage: Vintage, sent: Record<string, unknown>): Record<string, unknown> {
  if (sent["op"] !== "browser.view" || !isRecord(sent["args"])) return sent;
  const rest = Object.fromEntries(Object.entries(sent["args"]).filter(([key]) => key !== "build"));
  return { ...sent, args: vintage === "old-build" ? { ...rest, build: OLD_BUILD } : rest };
}

export class StaleLink {
  readonly url: string;
  private readonly server: Server;

  private constructor(server: Server, port: number) {
    this.server = server;
    this.url = `ws://127.0.0.1:${String(port)}/session`;
  }

  static async start(carddUrl: string, vintage: Vintage): Promise<StaleLink> {
    const call = carddUrl.replace(/^ws/, "http").replace(/\/session$/, "/call");
    const server = createServer((request, response) => {
      readBody(request)
        .then(async (body) => {
          const sent = parseRecord(body);
          if (sent["op"] === "browser.entered") {
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ ok: true, value: {} }));
            return;
          }
          const answer = await fetch(call, {
            method: "POST",
            headers: {
              authorization: request.headers.authorization ?? "",
              "content-type": "application/json",
            },
            body: JSON.stringify(spoken(vintage, sent)),
          });
          response
            .writeHead(answer.status, { "content-type": "application/json" })
            .end(await answer.text());
        })
        .catch(() => {
          response.writeHead(502).end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") throw new Error("the link has no port");
    return new StaleLink(server, address.port);
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
