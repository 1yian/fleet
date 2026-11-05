import { check } from "@fleet/protocol";
import Type, { type Static } from "typebox";

const LoginsSchema = Type.Object({
  host: Type.String({ minLength: 1 }),
  tokenFile: Type.String({ minLength: 1 }),
  project: Type.String({ pattern: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" }),
  totp: Type.Optional(Type.Boolean()),
});

const BrowserConfigSchema = Type.Object({
  cdp: Type.String({ minLength: 1 }),
  logins: Type.Optional(LoginsSchema),
});

export type BrowserConfig = Static<typeof BrowserConfigSchema>;
export type LoginsConfig = Static<typeof LoginsSchema>;

const USAGE =
  'a JSON object such as {"cdp":"http://100.64.0.5:9223","logins":{"host":"p620","tokenFile":"~/.config/bws/browser-logins.token","project":"<project id>"}}';

export function parseBrowserConfig(raw: string): BrowserConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--browser must be ${USAGE}`);
  }
  const config = check(BrowserConfigSchema, parsed);
  const endpoint = new URL(config.cdp);
  if (!["http:", "https:", "ws:", "wss:"].includes(endpoint.protocol))
    throw new Error(`--browser cdp ${config.cdp} must be an http(s) or ws(s) URL`);
  return config;
}
