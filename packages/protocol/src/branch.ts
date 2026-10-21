export const BRANCH_TYPES = [
  "feat",
  "fix",
  "refactor",
  "perf",
  "docs",
  "test",
  "chore",
  "ci",
  "build",
] as const;
const BRANCH_SLUG_MAX = 48;
const BRANCH_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function branchNameProblem(name: string): string | undefined {
  const [type = "", ...rest] = name.split("/");
  const slug = rest.join("/");
  const shape = `<type>/<slug>, with a type of ${BRANCH_TYPES.join(", ")} and a lowercase kebab-case slug of at most ${String(BRANCH_SLUG_MAX)} characters, such as fix/mileage-readback`;
  const typed = BRANCH_TYPES.some((each) => each === type);
  if (rest.length === 1 && typed && slug.length <= BRANCH_SLUG_MAX && BRANCH_SLUG.test(slug))
    return undefined;
  return `branch name "${name}" must be ${shape}`;
}
