import { check } from "@fleet/protocol";
import Type, { type Static } from "typebox";

const LoginsSchema = Type.Object({
  tokenFile: Type.String({ minLength: 1 }),
  project: Type.String({ pattern: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" }),
  totp: Type.Optional(Type.Boolean()),
});

const HostBrowserSchema = Type.Object({
  cdp: Type.String({ minLength: 1 }),
  logins: Type.Optional(LoginsSchema),
});

const BrowserConfigSchema = Type.Record(Type.String({ minLength: 1 }), HostBrowserSchema);

export type HostBrowserConfig = Static<typeof HostBrowserSchema>;
export type LoginsConfig = Static<typeof LoginsSchema>;
export type BrowserConfig = Readonly<Record<string, HostBrowserConfig>>;

const USAGE =
  'a JSON object that names each host, such as {"p620":{"cdp":"http://127.0.0.1:9222","logins":{"tokenFile":"~/.config/bws/browser-logins.token","project":"<project id>"}}}';

export function parseBrowserConfig(raw: string): BrowserConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--browser must be ${USAGE}`);
  }
  if (typeof parsed === "object" && parsed !== null && "cdp" in parsed)
    throw new Error(`--browser names one browser for each host now, so it must be ${USAGE}`);
  const config = check(BrowserConfigSchema, parsed);
  const hosts = Object.entries(config);
  if (hosts.length === 0) throw new Error(`--browser names no host: it must be ${USAGE}`);
  for (const [host, { cdp }] of hosts) {
    const endpoint = new URL(cdp);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "ws:")
      throw new Error(`--browser ${host}: cdp ${cdp} must be an http or ws URL on that host`);
  }
  return config;
}
