export const NO_MISTAKES_REPO = "https://github.com/1yian/no-mistakes";
const NO_MISTAKES_FLOOR = { commit: "980a45cf", date: "2026-11-18T03:52:20Z" } as const;
export const PI_TIERS_SOURCE = "git:github.com/1yian/pi-tiers";

const BUILD = /\bfork-([0-9a-f]{8}) \(([0-9a-f]{8})\) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/;

export function noMistakesBuild(output: string): { commit: string; date: string } | undefined {
  const found = BUILD.exec(output);
  const [, commit, , date] = found ?? [];
  return commit === undefined || date === undefined ? undefined : { commit, date };
}

export function noMistakesRefusal(output: string): string | undefined {
  const build = noMistakesBuild(output);
  if (build === undefined)
    return `reports "${output.trim().split("\n")[0] ?? ""}", which is not a build of the 1yian/no-mistakes fork`;
  return build.date < NO_MISTAKES_FLOOR.date
    ? `fork-${build.commit} (${build.date}) is too old`
    : undefined;
}

export const NO_MISTAKES_FIX = `install a build of 1yian/no-mistakes at fork-${NO_MISTAKES_FLOOR.commit} (${NO_MISTAKES_FLOOR.date}) or later: run bin/fleet install in the fleet checkout (it needs Go, builds into ~/.local/bin, and that folder must come first on the PATH)`;
