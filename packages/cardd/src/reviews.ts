import type { DatabaseSync } from "node:sqlite";
import { loadCard, type Session } from "./store.ts";

const LAVISH = /^lavish-axi(?:@[\w.-]+)?$/;
const LAVISH_CLI = /(?:^|\/)lavish-axi\/dist\/cli\.mjs$/;
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

const TOKEN = /([;|&\n])|((?:'[^']*'|"(?:\\[^]|[^"\\])*"|\\[^]|[^\s;|&'"\\])+)/g;
const PIECE = /'([^']*)'|"((?:\\[^]|[^"\\])*)"|\\([^])|([^'"\\]+)/g;

function unquote(word: string): string {
  return word.replace(
    PIECE,
    (_, single?: string, double?: string, escaped?: string, plain?: string) =>
      single ?? double?.replace(/\\([^])/g, "$1") ?? escaped ?? plain ?? "",
  );
}

function commandsOf(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  for (const [, separator, word] of command.matchAll(TOKEN)) {
    if (separator === undefined) words.push(unquote(word ?? ""));
    else if (words.length > 0) {
      commands.push(words);
      words = [];
    }
  }
  if (words.length > 0) commands.push(words);
  return commands;
}

function invokes(first: string, args: readonly string[]): boolean {
  if (LAVISH.test(first)) return args[0] === "poll";
  if (first === "node") return LAVISH_CLI.test(args[0] ?? "") && args[1] === "poll";
  if (first !== "npx") return false;
  const [tool = "", verb = ""] = args[0] === "--yes" ? args.slice(1) : args;
  return LAVISH.test(tool) && verb === "poll";
}

function polls(words: readonly string[]): boolean {
  const [first = "", ...args] = words.slice(words.findIndex((each) => !ASSIGNMENT.test(each)));
  return invokes(first, args);
}

const NEEDS_DECISION =
  "a Lavish poll waits on the captain, and nothing holds this card yet: report needs-decision with a new review key and the page link first, so your mate sees the wait and can ask the captain, then start the poll again. A working report does not hold the card.";

export function requireReviewDecision(db: DatabaseSync, session: Session, command: string): void {
  if (session.card === null || !commandsOf(command).some(polls)) return;
  if (loadCard(db, session.card).standing.facts.hold === undefined) throw new Error(NEEDS_DECISION);
}
