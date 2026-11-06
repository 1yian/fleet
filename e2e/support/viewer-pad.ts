import assert from "node:assert/strict";
import { chromium, type Browser as Client, type BrowserContext, type Page } from "playwright";
import { BrowserLab, type RawWorker } from "./browser-lab.ts";
import { FakeVault } from "./fake-vault.ts";
import { isRecord } from "./json.ts";
import { GOOD } from "./login-fixtures.ts";
import {
  launchViewer,
  pointInPicture,
  showTab,
  stopViewers,
  waitFor,
  type Viewers,
} from "./viewer.ts";

export const FIELD = { x: 200, y: 96 };

const TEXT_RECT = (from: number, to: number): string => `(() => {
  const text = document.getElementById("line").firstChild;
  const range = document.createRange();
  range.setStart(text, ${String(from)});
  range.setEnd(text, ${String(to)});
  const box = range.getBoundingClientRect();
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
})()`;

export class ViewerPad {
  readonly vault: FakeVault;
  readonly lab: BrowserLab;
  readonly client: Client;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly pad: RawWorker;
  readonly captain: string;
  readonly viewers: Viewers;

  private constructor(
    vault: FakeVault,
    lab: BrowserLab,
    client: Client,
    context: BrowserContext,
    page: Page,
    pad: RawWorker,
    captain: string,
    viewers: Viewers,
  ) {
    this.vault = vault;
    this.lab = lab;
    this.client = client;
    this.context = context;
    this.page = page;
    this.pad = pad;
    this.captain = captain;
    this.viewers = viewers;
  }

  static async start(): Promise<ViewerPad> {
    const vault = new FakeVault([]);
    vault.publish([GOOD]);
    const lab = await BrowserLab.start({ vault });
    const pad = await lab.worker("Users edit text");
    await pad.act({ action: "open", url: lab.site.url("/pad") });
    const viewers: Viewers = [];
    const captain = await launchViewer(lab, viewers, ["--captain"]);
    const client = await chromium.launch();
    const context = await client.newContext({
      viewport: { width: 1400, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    return new ViewerPad(vault, lab, client, context, page, pad, captain, viewers);
  }

  async stop(): Promise<void> {
    const stopped = await Promise.allSettled([
      ...stopViewers(this.viewers),
      this.client.close(),
      this.lab.stop(),
    ]);
    this.vault.dispose();
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed !== undefined) throw new Error(`cleanup failed: ${String(failed.reason)}`);
  }

  show(address: string, label?: string, state?: string): Promise<void> {
    return showTab(this.page, address, label, state);
  }

  async inPage(who: RawWorker, expression: string): Promise<unknown> {
    return JSON.parse(await who.act({ action: "eval", expression }));
  }

  async seen(who: RawWorker = this.pad): Promise<string[]> {
    const lines = await this.inPage(who, "window.seen");
    assert.ok(Array.isArray(lines) && lines.every((line) => typeof line === "string"));
    return lines.map(String);
  }

  async sawAll(wanted: string[], what: string): Promise<void> {
    await waitFor(async () => {
      const lines = await this.seen();
      return wanted.every((start) => lines.some((line) => line.startsWith(start)));
    }, what);
  }

  async numbers(who: RawWorker, expression: string): Promise<Record<string, number>> {
    const found = await this.inPage(who, expression);
    assert.ok(isRecord(found));
    return Object.fromEntries(Object.entries(found).map(([name, value]) => [name, Number(value)]));
  }

  async picturePoint(
    x: number,
    y: number,
    who: RawWorker = this.pad,
  ): Promise<{ x: number; y: number }> {
    const size = await this.numbers(who, "({ width: innerWidth, height: innerHeight })");
    return pointInPicture(
      this.page,
      { width: size["width"] ?? 1, height: size["height"] ?? 1 },
      x,
      y,
    );
  }

  async clickInPicture(x: number, y: number): Promise<void> {
    const at = await this.picturePoint(x, y);
    await this.page.mouse.click(at.x, at.y);
  }

  fieldValue(): Promise<unknown> {
    return this.inPage(this.pad, "document.getElementById('field').value");
  }

  async dragOver(from: number, to: number): Promise<void> {
    const box = await this.numbers(this.pad, TEXT_RECT(from, to));
    const middle = ((box["top"] ?? 0) + (box["bottom"] ?? 0)) / 2;
    const start = await this.picturePoint((box["left"] ?? 0) + 1, middle);
    const end = await this.picturePoint((box["right"] ?? 0) - 1, middle);
    await this.page.mouse.move(start.x, start.y);
    await this.page.mouse.down();
    await this.page.mouse.move(end.x, end.y, { steps: 8 });
    await this.page.mouse.up();
  }

  async clipboardEvents(): Promise<string[]> {
    return (await this.seen()).filter((line) => ["copy", "cut", "paste"].includes(line));
  }

  selected(): Promise<unknown> {
    return this.inPage(this.pad, "getSelection().toString()");
  }

  clipboard(): Promise<string> {
    return this.page.evaluate(() => navigator.clipboard.readText());
  }

  setClipboard(text: string): Promise<void> {
    return this.page.evaluate((value) => navigator.clipboard.writeText(value), text);
  }
}
