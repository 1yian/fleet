import { appendFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { BrokerErrorCode, BrokerRequest, BrokerResponse } from "../shared/broker-protocol.js";
import { loadBrokerConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { findMessage } from "./mail.js";
import { OnePassword } from "./op.js";
import { syncLane } from "./vaults.js";

const config = loadBrokerConfig();
const token = readFileSync(config.tokenFile, "utf8").trim();
if (token === "") throw new Error("the broker's 1Password token file is empty");
const onePassword = new OnePassword(config, token);
const auditPath = join(config.stateDir, "audit.log");
const vaultState = new Map<string, string>();

function auditLine(text: string): void {
  appendFileSync(auditPath, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
}

function audit(request: BrokerRequest, outcome: string): void {
  const item = "item" in request ? request.item : "-";
  auditLine(`${request.op} lane=${request.lane} item=${item} ${outcome}`);
}

async function syncAll(): Promise<void> {
  for (const [lane, titles] of Object.entries(config.lanes)) {
    try {
      const done = await syncLane(onePassword.opCli, config, lane, titles, auditLine);
      vaultState.set(lane, `ready: ${done.copied} copied, ${done.failed} failed, ${done.removed} removed`);
    } catch (error) {
      const code = error instanceof BrokerError ? error.code : "OP_ERROR";
      vaultState.set(lane, `error=${code}`);
      auditLine(`sync lane=${lane} item=- error=${code}`);
    }
  }
}

const synced = syncAll();

function parseRequest(line: string): BrokerRequest | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (typeof raw.lane !== "string") return null;
    if (raw.op === "status") return { op: "status", lane: raw.lane };
    if (typeof raw.item !== "string" || raw.item === "") return null;
    if (raw.op === "secret" || raw.op === "otp") return { op: raw.op, lane: raw.lane, item: raw.item };
    if (
      raw.op === "mail" &&
      (raw.kind === "link" || raw.kind === "code") &&
      typeof raw.sinceSeconds === "number"
    ) {
      return {
        op: "mail",
        lane: raw.lane,
        item: raw.item,
        kind: raw.kind,
        sinceSeconds: Math.max(30, Math.min(raw.sinceSeconds, 24 * 3600)),
        match: typeof raw.match === "string" ? raw.match : undefined,
        pattern: typeof raw.pattern === "string" ? raw.pattern : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function handle(request: BrokerRequest): Promise<BrokerResponse<unknown>> {
  if (request.op !== "status") await synced;
  switch (request.op) {
    case "secret": {
      const item = await onePassword.item(request.lane, request.item);
      return {
        ok: true,
        data: { username: item.username, password: item.password, totp: item.totp, urls: item.urls },
      };
    }
    case "otp": {
      const item = await onePassword.item(request.lane, request.item);
      if (!item.totp) throw new BrokerError("ITEM_NOT_FOUND", "the item has no one-time password field");
      return { ok: true, data: { username: null, password: null, totp: item.totp, urls: item.urls } };
    }
    case "mail": {
      const mailbox = await onePassword.item(request.lane, request.item, 5 * 60 * 1000);
      const message = await findMessage(mailbox, request);
      if (!message) throw new BrokerError("NO_MESSAGE", "no matching message in the mailbox yet");
      return { ok: true, data: message };
    }
    case "status":
      return {
        ok: true,
        data: {
          ratelimit: await onePassword.ratelimit(),
          localReadsLast24h: onePassword.readsLast24h(),
          localDailyBudget: config.dailyReadBudget,
          vaults: Object.fromEntries(vaultState),
        },
      };
  }
}

const server = createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const request = parseRequest(line);
    const reply = (response: BrokerResponse<unknown>): void => {
      socket.end(`${JSON.stringify(response)}\n`);
    };
    if (!request) {
      reply({ ok: false, code: "BAD_REQUEST", error: "malformed broker request" });
      return;
    }
    handle(request)
      .then((response) => {
        audit(request, "ok");
        reply(response);
      })
      .catch((error: unknown) => {
        const code: BrokerErrorCode = error instanceof BrokerError ? error.code : "OP_ERROR";
        audit(request, `error=${code}`);
        reply({ ok: false, code, error: error instanceof BrokerError ? error.message : "broker failure" });
      });
  });
  socket.on("error", () => undefined);
});

rmSync(config.socket, { force: true });
server.listen(config.socket, () => {
  chmodSync(config.socket, 0o660);
  process.stdout.write(`broker listening on ${config.socket}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
