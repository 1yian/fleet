import { readFileSync } from "node:fs";
import type { Handoff } from "../shared/protocol.js";
import type { Config } from "./config.js";

export class Notifier {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async handoffOpened(lane: string, handoff: Handoff, viewLink: string | null): Promise<void> {
    const settings = this.config.notify;
    if (!settings || handoff.status !== "open") return;
    const topic = readFileSync(settings.topicFile, "utf8").trim();
    const headers: Record<string, string> = {
      Title: `Browser needs you: ${lane}`,
      Priority: "high",
      Tags: "globe_with_meridians",
    };
    if (viewLink) headers.Click = viewLink;
    const response = await fetch(`${settings.url.replace(/\/$/, "")}/${topic}`, {
      method: "POST",
      headers,
      body: handoff.reason,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`the notification service answered ${response.status}`);
  }
}
