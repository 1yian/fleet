import type { DatabaseSync } from "node:sqlite";

interface Project {
  readonly name: string;
  readonly delivery: string;
  readonly base: string;
  readonly clones: { host: string; path: string }[];
  readonly yolo: boolean;
}

export function listProjects(db: DatabaseSync): Project[] {
  return db
    .prepare(
      "SELECT name, delivery, default_base AS base, clones, yolo FROM projects ORDER BY name",
    )
    .all()
    .map((row) => {
      const clones: unknown = JSON.parse(String(row["clones"]));
      const paths = typeof clones === "object" && clones !== null ? Object.entries(clones) : [];
      return {
        name: String(row["name"]),
        delivery: String(row["delivery"]),
        base: String(row["base"]),
        clones: paths.map(([host, path]) => ({ host, path: String(path) })),
        yolo: row["yolo"] === 1,
      };
    });
}
