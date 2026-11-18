import config from "./.oxlintrc.json" with { type: "json" };

export function projects() {
  const values = config.settings?.fleet?.projects;
  if (
    !Array.isArray(values) ||
    !values.length ||
    !values.every((value) => typeof value === "string" && value.length)
  )
    throw new Error("Missing or invalid Fleet projects policy.");
  return values;
}
