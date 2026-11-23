import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { type OpArgs } from "@fleet/protocol";
import { mainLane, type Session } from "./store.ts";

const REPO = "github.com/1yian/fleet";
const TITLE_LIMIT = 80;
const GH_TIMEOUT_MS = 30_000;
const exec = promisify(execFile);

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

interface Issue {
  readonly title: string;
  readonly body: string;
}

function literalCode(text: string): string {
  const line = text.replace(/\r\n?|\n/g, " ");
  if (!/\S/.test(line)) return line;
  let width = 1;
  for (const [run] of line.matchAll(/`+/g)) width = Math.max(width, run.length + 1);
  const fence = "`".repeat(width);
  const pad = /^[` ]|[` ]$/.test(line) ? " " : "";
  return `${fence}${pad}${line}${pad}${fence}`;
}

function issueFor(session: Session, text: string, about: About, now: number): Issue {
  const title = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(title);
  const details = [
    `Time: ${new Date(now).toISOString()}`,
    `Role: ${session.role}`,
    `Lane: ${literalCode(session.lane)}`,
    ...(about.card === null ? [] : [`Card: c-${String(about.card)}`]),
    ...(about.project === null ? [] : [`Project: ${literalCode(about.project)}`]),
  ];
  return {
    title:
      characters.length > TITLE_LIMIT
        ? `${characters.slice(0, TITLE_LIMIT - 3).join("")}...`
        : title,
    body: `    ${text.replace(/\r\n?|\n/g, "\n    ")}\n\n${details.map((line) => `- ${line}`).join("\n")}\n`,
  };
}

export function fileComplaint(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"complaint.publish">,
  now: number,
): void {
  const about = aboutCard(db, session, session.card ?? args.card);
  const { title, body } = issueFor(session, args.text, about, now);
  void Promise.resolve()
    .then(() =>
      exec("gh", ["issue", "create", "--repo", REPO, "--title", title, "--body", body], {
        timeout: GH_TIMEOUT_MS,
      }),
    )
    .catch(() => {
      console.error(
        `cardd: complaint filing unconfirmed for ${session.id} on ${REPO}: gh issue create failed`,
      );
    });
}
