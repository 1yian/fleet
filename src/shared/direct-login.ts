import { isLaneName, type LaneName } from "./lane-name.js";

export const DIRECT_LOGIN_LIMIT = 16 * 1024;

export interface DirectLogin {
  lane: LaneName;
  origin: string;
  url: string;
  username?: string;
  password: string;
}

export function isLoopback(host: string | undefined): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";
}

export function parseDirectLogin(raw: unknown): DirectLogin | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { lane, origin, url, username, password } = raw as Record<string, unknown>;
  if (
    !isLaneName(lane) ||
    typeof origin !== "string" ||
    typeof url !== "string" ||
    typeof password !== "string" ||
    !password
  )
    return null;
  if (username !== undefined && (typeof username !== "string" || !username)) return null;
  try {
    const site = new URL(origin);
    if (origin !== site.origin || site.protocol !== "https:") return null;
    const page = new URL(url);
    if (page.protocol !== "https:" || page.origin !== origin || page.username || page.password) return null;
    return { lane, origin, url, username, password };
  } catch {
    return null;
  }
}
