export type BrokerRequest =
  | { op: "secret"; lane: string; item: string }
  | { op: "otp"; lane: string; item: string }
  | {
      op: "mail";
      lane: string;
      item: string;
      kind: "link" | "code";
      sinceSeconds: number;
      match?: string;
      pattern?: string;
    }
  | { op: "status"; lane: string };

export interface SecretData {
  username: string | null;
  password: string | null;
  totp: string | null;
  urls: string[];
}

export interface MailData {
  value: string;
  subject: string;
  from: string;
  receivedAt: number;
}

export interface StatusData {
  ratelimit: string;
  localReadsLast24h: number;
  localDailyBudget: number;
  vaults: Record<string, string>;
}

export type BrokerErrorCode =
  | "BAD_TOKEN"
  | "NOT_ALLOWED"
  | "ITEM_NOT_FOUND"
  | "RATE_LIMITED"
  | "BUDGET"
  | "NO_MESSAGE"
  | "MAIL_ERROR"
  | "OP_ERROR"
  | "BAD_REQUEST";

export type BrokerResponse<T> = { ok: true; data: T } | { ok: false; code: BrokerErrorCode; error: string };
