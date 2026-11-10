import Type, { type Static } from "typebox";

const PartitionKeySchema = Type.Union([
  Type.String(),
  Type.Object({ topLevelSite: Type.String(), hasCrossSiteAncestor: Type.Boolean() }),
]);

export const CookieSchema = Type.Object({
  name: Type.String(),
  value: Type.String(),
  domain: Type.String(),
  path: Type.String(),
  expires: Type.Number(),
  httpOnly: Type.Boolean(),
  secure: Type.Boolean(),
  session: Type.Boolean(),
  sameSite: Type.Optional(Type.String()),
  priority: Type.Optional(Type.String()),
  partitionKey: Type.Optional(PartitionKeySchema),
});

export const StorageSchema = Type.Object({
  local: Type.Record(Type.String(), Type.String()),
  tab: Type.Record(Type.String(), Type.String()),
});

export type Cookie = Static<typeof CookieSchema>;
export type Storage = Static<typeof StorageSchema>;

export interface Session {
  readonly origin: string;
  readonly urls: readonly string[];
  readonly cookies: readonly Cookie[];
  readonly storage: Storage | undefined;
}

const cookieKey = (cookie: Cookie): string =>
  [cookie.name, cookie.domain, cookie.path, JSON.stringify(cookie.partitionKey ?? null)].join("|");

function differing(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]);
}

export function changes(held: Session, now: Session): string[] {
  const before = Object.fromEntries(held.cookies.map((cookie) => [cookieKey(cookie), cookie]));
  const after = Object.fromEntries(now.cookies.map((cookie) => [cookieKey(cookie), cookie]));
  const cookies = differing(
    Object.fromEntries(Object.entries(before).map(([key, cookie]) => [key, cookie.value])),
    Object.fromEntries(Object.entries(after).map(([key, cookie]) => [key, cookie.value])),
  ).map((key) => `${(before[key] ?? after[key])?.name ?? key} (cookie)`);
  if (held.storage === undefined || now.storage === undefined) return cookies;
  return [
    ...cookies,
    ...differing(held.storage.local, now.storage.local).map((key) => `${key} (localStorage)`),
    ...differing(held.storage.tab, now.storage.tab).map((key) => `${key} (sessionStorage)`),
  ];
}

export function counts(session: Session): string {
  const storage = session.storage;
  const local = storage === undefined ? 0 : Object.keys(storage.local).length;
  const tab = storage === undefined ? 0 : Object.keys(storage.tab).length;
  return `${String(session.cookies.length)} cookies, ${String(local)} localStorage items, ${String(tab)} sessionStorage items`;
}
