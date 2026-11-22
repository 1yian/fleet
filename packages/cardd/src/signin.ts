import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { check, OPS, type BoardAction, type Card } from "@fleet/protocol";
import type { Session } from "./store.ts";

type GrantAction = Extract<BoardAction["action"], { kind: "signin-grant" }>;

const MAX_PASSWORD = 1024;
const MAX_URL = 2048;
const REFUSED = "no sign-in grant matches this request, or it was already used";

function signinUrl(raw: string): { url: string; origin: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("the sign-in URL is not a URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    throw new Error(
      "the sign-in URL must be https, with no embedded credentials",
    );
  if (parsed.href.length > MAX_URL)
    throw new Error(
      `the sign-in URL is longer than ${String(MAX_URL)} characters once encoded`,
    );
  return { url: parsed.href, origin: parsed.origin };
}

function selected(
  body: string,
  start: number | null,
  end: number | null,
): string {
  const points = Array.from(body);
  const text =
    start === null || end === null ? body : points.slice(start, end).join("");
  if (
    text === "" ||
    text.length > MAX_PASSWORD ||
    /[\r\n]/.test(text) ||
    (end !== null && end > points.length)
  )
    throw new Error(
      "the selected text is not a one-line password: select the exact span of the entry that is the password",
    );
  return text;
}

function bodyOf(db: DatabaseSync, entry: number, card?: number): string {
  const row = db
    .prepare(
      "SELECT body FROM entries WHERE id = ? AND (? IS NULL OR card = ?)",
    )
    .get(entry, card ?? null, card ?? null);
  if (typeof row?.["body"] !== "string")
    throw new Error(`there is no entry ${String(entry)} here`);
  return row["body"];
}

export function createGrant(
  db: DatabaseSync,
  card: Card,
  action: GrantAction,
): { grant: string; text: string } {
  const { url } = signinUrl(action.url);
  if (
    db.prepare("SELECT 1 FROM lanes WHERE name = ?").get(action.lane) ===
    undefined
  )
    throw new Error(`there is no lane ${action.lane}`);
  const start = action.span?.start ?? null;
  const end = action.span?.end ?? null;
  selected(bodyOf(db, action.entry, card.id), start, end);
  const grant = `sg-${randomBytes(8).toString("hex")}`;
  db.prepare(
    "INSERT INTO signin_grants (id, entry, lane, url, username, span_start, span_end) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    grant,
    action.entry,
    action.lane,
    url,
    action.username ?? null,
    start,
    end,
  );
  const text = `Sign-in grant ${grant}: one use, for lane ${action.lane}, entry ${String(action.entry)}, at ${url}. A worker in that lane redeems it with browser_signin(grant, entry, url). The password stays in the entry and is never copied here. If the sign-in fails, the grant is spent: the captain must make a new one.`;
  return { grant, text };
}

export function redeemGrant(
  db: DatabaseSync,
  session: Session,
  raw: unknown,
  now: number,
): unknown {
  const args = check(OPS["signin.redeem"].args, raw);
  const { url, origin } = signinUrl(args.url);
  const row = db
    .prepare(
      `UPDATE signin_grants SET redeemed_at = ?
       WHERE id = ? AND lane = ? AND entry = ? AND url = ? AND redeemed_at IS NULL
       RETURNING username, span_start, span_end`,
    )
    .get(now, args.grant, session.lane, args.entry, url);
  if (row === undefined) throw new Error(REFUSED);
  const start =
    typeof row["span_start"] === "number" ? row["span_start"] : null;
  const end = typeof row["span_end"] === "number" ? row["span_end"] : null;
  const password = selected(bodyOf(db, args.entry), start, end);
  const username =
    typeof row["username"] === "string" ? { username: row["username"] } : {};
  return { lane: session.lane, origin, url, ...username, password };
}
