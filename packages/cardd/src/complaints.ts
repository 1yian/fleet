import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { type OpArgs } from "@fleet/protocol";
import { sanitize } from "./incident-kinds.ts";
import { mainLane, type Session } from "./store.ts";

const REPO = "1yian/fleet";
const LABEL = "complaint";
const LABEL_DESCRIPTION = "Feedback from an agent about how the fleet's own setup annoyed it";
const TITLE_LIMIT = 80;
const GH_TIMEOUT_MS = 30_000;

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

function gh(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: GH_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error === null) resolve();
      else reject(new Error(sanitize(stderr.trim() || error.message)));
    });
  });
}

const failed = (what: string, error: unknown): void => {
  console.error(
    `cardd: ${what}: ${error instanceof Error ? error.message : sanitize(String(error))}`,
  );
};

interface Issue {
  readonly title: string;
  readonly body: string;
}

function issueFor(session: Session, args: OpArgs<"complain">, about: About, now: number): Issue {
  const text = sanitize(args.text);
  const details = [
    `Time: ${new Date(now).toISOString()}`,
    `Role: ${session.role}`,
    `Lane: ${session.lane}`,
    ...(about.card === null ? [] : [`Card: c-${String(about.card)}`]),
    ...(about.project === null ? [] : [`Project: ${about.project}`]),
  ];
  return {
    title: text.length > TITLE_LIMIT ? `${text.slice(0, TITLE_LIMIT - 3)}...` : text,
    body: `${text}\n\n${details.map((line) => `- ${line}`).join("\n")}\n`,
  };
}

async function file({ title, body }: Issue): Promise<void> {
  const labelled = await gh([
    "label",
    "create",
    LABEL,
    "--repo",
    REPO,
    "--force",
    "--description",
    LABEL_DESCRIPTION,
  ]).then(
    () => true,
    (error: unknown) => {
      failed(`could not create the ${LABEL} label on ${REPO}`, error);
      return false;
    },
  );
  await gh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    title,
    "--body",
    body,
    ...(labelled ? ["--label", LABEL] : []),
  ]);
}

export function fileComplaint(
  db: DatabaseSync,
  session: Session,
  args: OpArgs<"complain">,
  now: number,
): void {
  const about = aboutCard(db, session, session.card ?? args.card);
  file(issueFor(session, args, about, now)).catch((error: unknown) => {
    failed(`a complaint from ${session.id} was dropped, not filed on ${REPO}`, error);
  });
}
