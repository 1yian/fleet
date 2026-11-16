import type { DatabaseSync } from "node:sqlite";
import { type Complaint, type OpArgs } from "@fleet/protocol";
import { sanitize } from "./incident-kinds.ts";
import { mainLane, type Session } from "./store.ts";

const DEFAULT_LIMIT = 20;

interface About {
  readonly card: number | null;
  readonly project: string | null;
}

function aboutCard(db: DatabaseSync, session: Session, id: number | undefined): About {
  const row =
    id === undefined
      ? undefined
      : db
          .prepare(
            "SELECT id, coalesce(project, historical_project) AS project FROM cards WHERE id = ? AND (? OR lane = ?)",
          )
          .get(id, session.lane === mainLane(db) ? 1 : 0, session.lane);
  return {
    card: typeof row?.["id"] === "number" ? row["id"] : null,
    project: typeof row?.["project"] === "string" ? row["project"] : null,
  };
}

export function recordComplaint(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"complain">,
  now: number,
): number {
  const { card, project } = aboutCard(db, session, session.card ?? args.card);
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO complaints (at, session, role, lane, card, project, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(now, session.id, session.role, session.lane, card, project, sanitize(args.text));
  return Number(lastInsertRowid);
}

const complaintFrom = (row: Record<string, unknown>): Complaint => ({
  id: Number(row["id"]),
  at: Number(row["at"]),
  session: String(row["session"]),
  role: row["role"] === "mate" ? "mate" : "worker",
  lane: String(row["lane"]),
  card: typeof row["card"] === "number" ? row["card"] : null,
  project: typeof row["project"] === "string" ? row["project"] : null,
  text: String(row["text"]),
});

export function listComplaints(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"complaints">,
): Complaint[] {
  const everything = session.lane === mainLane(db);
  return db
    .prepare(`SELECT * FROM complaints WHERE ? OR lane = ? ORDER BY id DESC LIMIT ?`)
    .all(everything ? 1 : 0, session.lane, args.limit ?? DEFAULT_LIMIT)
    .map(complaintFrom);
}
