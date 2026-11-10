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

export const StorageSchema = Type.Array(Type.Tuple([Type.String(), Type.String()]));

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

const meaning = (cookie: Cookie): string =>
  JSON.stringify([
    cookie.value,
    cookie.session ? null : cookie.expires,
    cookie.session,
    cookie.secure,
    cookie.httpOnly,
    cookie.sameSite ?? null,
    cookie.priority ?? null,
  ]);

function differing(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (key) => before.get(key) !== after.get(key),
  );
}

const byKey = (session: Session): Map<string, Cookie> =>
  new Map(session.cookies.map((cookie) => [cookieKey(cookie), cookie]));

const meanings = (cookies: ReadonlyMap<string, Cookie>): Map<string, string> =>
  new Map([...cookies].map(([key, cookie]) => [key, meaning(cookie)]));

export function changes(held: Session, now: Session): string[] {
  const before = byKey(held);
  const after = byKey(now);
  const cookies = differing(meanings(before), meanings(after)).map(
    (key) => `${(before.get(key) ?? after.get(key))?.name ?? key} (cookie)`,
  );
  if (held.storage === undefined || now.storage === undefined) return cookies;
  return [
    ...cookies,
    ...differing(new Map(held.storage), new Map(now.storage)).map((key) => `${key} (localStorage)`),
  ];
}

export function counts(session: Session): string {
  const local = session.storage?.length ?? 0;
  return `${String(session.cookies.length)} cookies, ${String(local)} localStorage items`;
}
