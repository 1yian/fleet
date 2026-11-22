export const CUTOVER_USAGE =
  "fleet job-cutover status | seal | confirm-stop <job> <evidence that the legacy job's process tree cannot run>";
export const USAGE = [
  "usage: fleet status | up [lane] [--maintenance] | stop <lane> | arrange [--host NAME] | restart [lane] | shared --content BASE64|--absent | scratch [--tidy] [--open CARD] [--move CARD] [--largest PATH ... [--by inodes|space]] [--json] | update [--check] | cardd --root R --db D [--check] [--running SHA] [--restart JSON] | home add <lane> --url U (--token-file FILE|- | --bws JSON) [--hold] [lane options] | home set <lane> [--args JSON] [--worker-args JSON] | home transport <host> <lane|all> --from <reference-lane> | home transport <host> --check | home memory <lane> [--seed DIR] [--thinking LEVEL] | wake <lane> <note> [--script NAME] | secrets [lane] | cost | migrate [--undo] | install [--latest]",
  CUTOVER_USAGE,
  "install checks the host's prerequisites and installs what they need: the no-mistakes fork, pi-tiers, the tiers template, and (on main's host) the daily update reminder. --latest rebuilds the no-mistakes fork from its latest main.",
  "lane options of home add: --host NAME --hosts JSON --roots JSON --tier MODEL --direnv FOLDER --args JSON --worker-args JSON",
  "  --hosts and --roots take a JSON object, --args and --worker-args a JSON array of strings. home set takes only --args and --worker-args, and changes only those.",
  "  --token-file reads the lane token from a file, or from standard input with -, so it never sits in a command line. --hold makes the home held until it is started.",
].join("\n");

export const VALUE_OPTIONS = new Set([
  "--from",
  "--url",
  "--token-file",
  "--bws",
  "--args",
  "--worker-args",
  "--host",
  "--hosts",
  "--roots",
  "--direnv",
  "--tier",
  "--seed",
  "--thinking",
  "--root",
  "--db",
  "--running",
  "--restart",
  "--content",
  "--script",
  "--largest",
  "--by",
  "--open",
  "--move",
]);
