import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadOpenCards, transaction } from "./store.ts";

const text = (value: unknown): string => String(value);

export function describeLanes(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT l.name AS name, l.parent AS parent, l.card AS card, l.home AS home, s.state AS mate
       FROM lanes l LEFT JOIN sessions s ON s.lane = l.name AND s.role = 'mate' ORDER BY l.name`,
    )
    .all();
  return rows.map((row) => {
    const parent = row["parent"] === null ? "no parent" : `parent ${text(row["parent"])}`;
    const mate = row["mate"] === null ? "no mate" : `mate ${text(row["mate"])}`;
    const card = row["card"] === null ? "no lane card" : `card c-${text(row["card"])}`;
    return `${text(row["name"])}: ${parent}, ${mate}, ${card}, home ${text(row["home"])}`;
  });
}

export function describeProjects(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name, delivery, yolo, repo, clones FROM projects ORDER BY name")
    .all();
  return rows.map((row) => {
    const parsed: unknown = JSON.parse(text(row["clones"]));
    const clones = Object.entries(typeof parsed === "object" && parsed !== null ? parsed : {});
    const where =
      clones.length === 0 ? "no clones" : clones.map(([h, p]) => `${h}=${text(p)}`).join(" ");
    const repo = row["repo"] === null ? "repo not set" : `repo ${text(row["repo"])}`;
    const yolo = row["yolo"] === 1 ? "on" : "off";
    return `${text(row["name"])}: ${text(row["delivery"])}, yolo ${yolo}, ${repo}, ${where}`;
  });
}

export function describeRepo(db: DatabaseSync, project: string): string {
  const repo = db.prepare("SELECT repo FROM projects WHERE name = ?").get(project)?.["repo"];
  if (typeof repo === "string") return `${project}: repo ${repo}`;
  return `${project}: repo not set. No clone's origin could be read from here. Run project repo ${project} <owner>/<name>, or give project add --hosts '{"<host>":["ssh","<host>"]}' so it can read a clone on another host`;
}

export function setLaneHome(db: DatabaseSync, lane: string, home: string): string {
  if (!isAbsolute(home)) throw new Error(`lane home ${home} must be an absolute path`);
  const before = db.prepare("SELECT home FROM lanes WHERE name = ?").get(lane)?.["home"];
  if (before === undefined) throw new Error(`lane ${lane} is not in the registry`);
  db.prepare("UPDATE lanes SET home = ? WHERE name = ?").run(home, lane);
  return `${lane}: home ${text(before)} -> ${home}`;
}

const cardNames = (ids: readonly unknown[]): string => ids.map((id) => `c-${text(id)}`).join(", ");

function refuseUnlessUnused(db: DatabaseSync, lane: string, laneCard: unknown): void {
  const children = db.prepare("SELECT name FROM lanes WHERE parent = ? ORDER BY name").all(lane);
  if (children.length > 0)
    throw new Error(
      `lane ${lane} is the parent of ${children.map((row) => text(row["name"])).join(", ")}: remove those first`,
    );
  const mate = db.prepare("SELECT state FROM sessions WHERE role = 'mate' AND lane = ?").get(lane);
  if (mate !== undefined && mate["state"] !== "exited")
    throw new Error(
      `lane ${lane} has a mate that is ${text(mate["state"])}: stop it first, with lane("${lane}", "stop") in main or fleet stop ${lane} on its host`,
    );
  const open = loadOpenCards(db).filter(({ card }) => card.lane === lane && card.id !== laneCard);
  if (open.length > 0)
    throw new Error(
      `lane ${lane} has open cards: ${cardNames(open.map(({ card }) => card.id))}. Close or move them first`,
    );
  const used = db
    .prepare(
      `SELECT DISTINCT c.id AS id FROM cards c JOIN entries e ON e.card = c.id
       WHERE c.lane = ? ORDER BY c.id`,
    )
    .all(lane);
  if (used.length > 0)
    throw new Error(
      `lane ${lane} has card history (${cardNames(used.map((row) => row["id"]))}). Entries are append-only, so only a lane that never worked a card can be removed`,
    );
  if (db.prepare("SELECT 1 FROM incidents WHERE actor = ?").get(lane) !== undefined)
    throw new Error(`lane ${lane} has incident records, so it cannot be removed`);
}

export function removeLane(db: DatabaseSync, lane: string): string {
  return transaction(db, () => {
    const found = db.prepare("SELECT card FROM lanes WHERE name = ?").get(lane);
    if (found === undefined) throw new Error(`lane ${lane} is not in the registry`);
    refuseUnlessUnused(db, lane, found["card"]);
    const schedules = db
      .prepare("DELETE FROM schedules WHERE owner = ? OR recipient = ?")
      .run(lane, lane).changes;
    db.prepare("DELETE FROM deliveries WHERE session = ?").run(lane);
    db.prepare("UPDATE lanes SET card = NULL WHERE name = ?").run(lane);
    db.prepare("DELETE FROM cards WHERE lane = ?").run(lane);
    db.prepare("DELETE FROM maintenance WHERE session = ? OR requester = ?").run(lane, lane);
    db.prepare("DELETE FROM sessions WHERE role = 'mate' AND lane = ?").run(lane);
    db.prepare("DELETE FROM lanes WHERE name = ?").run(lane);
    const dropped = schedules === 0 ? "" : `, with ${String(schedules)} of its schedules`;
    return `${lane}: removed the lane and its lane card${dropped}. Its token no longer connects. Its home on disk is untouched`;
  });
}
