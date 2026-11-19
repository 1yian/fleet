import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { MailData } from "../shared/broker-protocol.js";
import { BrokerError, type ItemData } from "./op.js";

const MAX_MESSAGES = 20;
const DEFAULT_CODE = /(?<![\w-])(\d{6})(?![\w-])/;
const IGNORED_LINK = /unsubscribe|privacy|terms|mailto:/i;

export interface MailQuery {
  kind: "link" | "code";
  sinceSeconds: number;
  match?: string;
  pattern?: string;
}

function regex(source: string | undefined, label: string): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source, "i");
  } catch {
    throw new BrokerError("BAD_REQUEST", `${label} is not a valid regular expression`);
  }
}

function extractLink(html: string, text: string, pattern: RegExp | null): string | null {
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) =>
    (m[1] ?? "").replaceAll("&amp;", "&"),
  );
  const bare = text.match(/https?:\/\/[^\s<>"')]+/g) ?? [];
  const candidates = [...new Set([...hrefs, ...bare])].filter((u) => /^https?:\/\//i.test(u));
  return candidates.find((u) => (pattern ? pattern.test(u) : !IGNORED_LINK.test(u))) ?? null;
}

function extractCode(text: string, pattern: RegExp | null): string | null {
  const found = (pattern ?? DEFAULT_CODE).exec(text);
  return found ? (found[1] ?? found[0]) : null;
}

export async function findMessage(mailbox: ItemData, query: MailQuery): Promise<MailData | null> {
  const user = mailbox.username;
  const pass = mailbox.password;
  if (!user || !pass)
    throw new BrokerError("MAIL_ERROR", "the mailbox item needs a username and a password (app password)");
  const host = mailbox.fields.get("server") ?? "imap.zoho.com";
  const port = Number(mailbox.fields.get("port") ?? "993");
  const secure = (mailbox.fields.get("tls") ?? "true").toLowerCase() !== "false";
  const match = regex(query.match, "match");
  const pattern = regex(query.pattern, "pattern");
  const client = new ImapFlow({ host, port, secure, auth: { user, pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - query.sinceSeconds * 1000);
      const uids = ((await client.search({ since }, { uid: true })) || [])
        .sort((a, b) => b - a)
        .slice(0, MAX_MESSAGES);
      for (const uid of uids) {
        const message = await client.fetchOne(
          String(uid),
          { source: true, envelope: true, internalDate: true },
          { uid: true },
        );
        if (message === false || !message.source) continue;
        const receivedAt = message.internalDate ? new Date(message.internalDate).getTime() : Date.now();
        if (receivedAt < since.getTime()) continue;
        const parsed = await simpleParser(message.source);
        const subject = parsed.subject ?? "";
        const from = parsed.from?.text ?? "";
        const text = parsed.text ?? "";
        const html = typeof parsed.html === "string" ? parsed.html : "";
        if (match && !match.test(`${subject}\n${from}\n${text}`)) continue;
        const value =
          query.kind === "link" ? extractLink(html, text, pattern) : extractCode(text || html, pattern);
        if (value) return { value, subject, from, receivedAt };
      }
      return null;
    } finally {
      lock.release();
    }
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError(
      "MAIL_ERROR",
      `mailbox access failed: ${error instanceof Error ? error.message.slice(0, 160) : "unknown error"}`,
    );
  } finally {
    await client.logout().catch(() => undefined);
  }
}
