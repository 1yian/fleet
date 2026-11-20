import type { MailData, SecretData, StatusData } from "../shared/broker-protocol.js";
import { brokerCall } from "./broker-client.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import {
  clearField,
  detectFields,
  type FieldInfo,
  fillField,
  focusedFieldKind,
  forgetFields,
  pageSummary,
  pressEnter,
  problemHints,
} from "./forms.js";
import type { Lane } from "./lane.js";
import { PageSession } from "./page-session.js";

const MAX_STEPS = 6;
const SETTLE_MS = 9000;

export interface LoginResult {
  outcome: "done" | "stuck" | "no-form" | "needs-otp" | "off-origin";
  steps: string[];
  url: string;
  title: string;
  hints: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function hostAllowed(pageHost: string, itemUrls: string[]): boolean {
  return itemUrls.some((raw) => {
    try {
      const host = new URL(raw).hostname;
      return pageHost === host || pageHost.endsWith(`.${host}`);
    } catch {
      return false;
    }
  });
}

function signature(url: string, fields: FieldInfo[]): string {
  return `${url}|${fields
    .filter((f) => f.visible)
    .map((f) => `${f.kind}${f.filled ? "+" : "-"}`)
    .join(",")}`;
}

async function snapshotSignature(page: PageSession): Promise<string> {
  try {
    const url = await page.evaluate<string>("location.href");
    return signature(url, await detectFields(page));
  } catch {
    return "navigating";
  }
}

async function settle(page: PageSession, before: string): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    await sleep(300);
    if ((await snapshotSignature(page)) !== before) {
      await sleep(900);
      return;
    }
  }
}

async function waitForLoad(page: PageSession): Promise<void> {
  await sleep(400);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate<string>("document.readyState").catch(() => "loading");
    if (state === "complete") return;
    await sleep(250);
  }
}

async function scrubFilledSecrets(page: PageSession): Promise<void> {
  try {
    for (const field of await detectFields(page)) {
      if (field.filled && (field.kind === "password" || field.kind === "otp" || field.kind === "newpassword"))
        await clearField(page, field.i);
    }
    await forgetFields(page);
  } catch {
    return;
  }
}

export class Credentials {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async login(lane: Lane, item: string): Promise<LoginResult> {
    const release = lane.beginStep("credentials");
    let page: PageSession | null = null;
    try {
      page = await PageSession.open(lane);
      const secrets = await this.secret(lane, item);
      const summary = await pageSummary(page);
      const pageHost = hostOf(summary.url);
      if (!hostAllowed(pageHost, secrets.urls)) {
        throw new HttpError(
          403,
          `item ${item} is bound to ${secrets.urls.map((u) => new URL(u).hostname).join(", ") || "no website"}; this page is ${pageHost}. Open the real sign-in page first.`,
        );
      }
      return await this.loginLoop(page, secrets, lane, item);
    } finally {
      if (page) {
        await scrubFilledSecrets(page);
        page.close();
      }
      release();
    }
  }

  private async loginLoop(
    page: PageSession,
    secrets: SecretData,
    lane: Lane,
    item: string,
  ): Promise<LoginResult> {
    const steps: string[] = [];
    let usernameDone = false;
    let passwordTries = 0;
    let otpTries = 0;
    let totp = secrets.totp;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const here = await pageSummary(page);
      if (!hostAllowed(hostOf(here.url), secrets.urls)) {
        return { ...(await this.result(page, steps)), outcome: "off-origin" };
      }
      const fields = (await detectFields(page)).filter((f) => f.visible);
      const password = fields.find((f) => f.kind === "password");
      const username = fields.find((f) => f.kind === "username" && !f.filled);
      const otp = fields.find((f) => f.kind === "otp");
      const before = signature(here.url, fields);
      if (password && secrets.password) {
        if (passwordTries >= 1) break;
        passwordTries += 1;
        if (username && secrets.username) await fillField(page, username.i, secrets.username);
        await fillField(page, password.i, secrets.password);
        steps.push(username && secrets.username ? "username+password" : "password");
      } else if (otp) {
        if (!totp) return { ...(await this.result(page, steps)), outcome: "needs-otp" };
        if (otpTries >= 2) break;
        if (otpTries === 1) {
          const fresh = (await this.secret(lane, item)).totp;
          if (!fresh || fresh === totp) break;
          totp = fresh;
        }
        await fillField(page, otp.i, totp);
        otpTries += 1;
        steps.push("otp");
      } else if (username && secrets.username && !usernameDone) {
        await fillField(page, username.i, secrets.username);
        usernameDone = true;
        steps.push("username");
      } else {
        break;
      }
      await pressEnter(page);
      await settle(page, before);
    }
    return this.result(page, steps);
  }

  private async result(page: PageSession, steps: string[]): Promise<LoginResult> {
    const fields = (await detectFields(page).catch(() => [])).filter((f) => f.visible);
    const summary = await pageSummary(page);
    const hints = await problemHints(page);
    const loginFieldsLeft = fields.some(
      (f) => f.kind === "password" || f.kind === "otp" || f.kind === "username",
    );
    const outcome = steps.length === 0 ? "no-form" : loginFieldsLeft ? "stuck" : "done";
    return { outcome, steps, url: summary.url, title: summary.title, hints };
  }

  async otp(
    lane: Lane,
    item: string,
    submit: boolean,
  ): Promise<{ typed: boolean; url: string; title: string }> {
    const release = lane.beginStep("credentials");
    let page: PageSession | null = null;
    try {
      page = await PageSession.open(lane);
      const secrets = await this.secret(lane, item, "otp");
      if (!secrets.totp) throw new HttpError(404, `item ${item} has no one-time password`);
      const pageHost = hostOf((await pageSummary(page)).url);
      if (!hostAllowed(pageHost, secrets.urls))
        throw new HttpError(403, `item ${item} is not bound to ${pageHost}`);
      const fields = await detectFields(page);
      const focused = await focusedFieldKind(page);
      const target =
        fields.find((f) => f.i === focused && f.visible) ?? fields.find((f) => f.kind === "otp" && f.visible);
      if (!target) throw new HttpError(404, "no one-time code field is visible on this page");
      const before = signature(
        (await pageSummary(page)).url,
        fields.filter((f) => f.visible),
      );
      await fillField(page, target.i, secrets.totp);
      if (submit) {
        await pressEnter(page);
        await settle(page, before);
      }
      const summary = await pageSummary(page);
      return { typed: true, ...summary };
    } finally {
      if (page) {
        if (submit) await scrubFilledSecrets(page);
        page.close();
      }
      release();
    }
  }

  async mail(
    lane: Lane,
    item: string,
    kind: "link" | "code",
    options: { match?: string; pattern?: string; sinceSeconds: number; waitSeconds: number; submit: boolean },
  ): Promise<{
    kind: string;
    subject: string;
    from: string;
    receivedAt: number;
    opened?: string;
    typed?: boolean;
    url: string;
    title: string;
  }> {
    const deadline = Date.now() + options.waitSeconds * 1000;
    let found: MailData;
    for (;;) {
      try {
        found = await brokerCall<MailData>(this.config.broker.socket, {
          op: "mail",
          lane: lane.name,
          item,
          kind,
          sinceSeconds: options.sinceSeconds,
          match: options.match,
          pattern: options.pattern,
        });
        break;
      } catch (error) {
        if ((error as { code?: string }).code === "NO_MESSAGE" && Date.now() < deadline) {
          await sleep(4000);
          continue;
        }
        throw this.translate(error);
      }
    }
    const release = lane.beginStep("credentials");
    let page: PageSession | null = null;
    try {
      page = await PageSession.open(lane);
      if (kind === "link") {
        await page.send("Page.navigate", { url: found.value });
        await waitForLoad(page);
        const summary = await pageSummary(page);
        return {
          kind,
          subject: found.subject,
          from: found.from,
          receivedAt: found.receivedAt,
          opened: new URL(found.value).hostname,
          ...summary,
        };
      }
      const fields = await detectFields(page);
      const focused = await focusedFieldKind(page);
      const target =
        fields.find((f) => f.i === focused && f.visible) ?? fields.find((f) => f.kind === "otp" && f.visible);
      if (!target) throw new HttpError(404, "no code field is visible on this page");
      const before = signature(
        (await pageSummary(page)).url,
        fields.filter((f) => f.visible),
      );
      await fillField(page, target.i, found.value);
      if (options.submit) {
        await pressEnter(page);
        await settle(page, before);
      }
      const summary = await pageSummary(page);
      return {
        kind,
        subject: found.subject,
        from: found.from,
        receivedAt: found.receivedAt,
        typed: true,
        ...summary,
      };
    } finally {
      if (page) {
        if (kind === "code" && options.submit) await scrubFilledSecrets(page);
        page.close();
      }
      release();
    }
  }

  async status(lane: Lane): Promise<StatusData> {
    try {
      return await brokerCall<StatusData>(this.config.broker.socket, { op: "status", lane: lane.name });
    } catch (error) {
      throw this.translate(error);
    }
  }

  private async secret(lane: Lane, item: string, op: "secret" | "otp" = "secret"): Promise<SecretData> {
    try {
      return await brokerCall<SecretData>(this.config.broker.socket, { op, lane: lane.name, item });
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): Error {
    if (error instanceof HttpError) return error;
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : "credential step failed";
    const status =
      code === "ITEM_NOT_FOUND" || code === "NO_MESSAGE"
        ? 404
        : code === "NOT_ALLOWED"
          ? 403
          : code === "RATE_LIMITED" || code === "BUDGET"
            ? 429
            : 502;
    return new HttpError(status, message);
  }
}
