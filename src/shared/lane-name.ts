export type LaneName = string & { readonly __laneName: true };

const LANE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isLaneName(value: unknown): value is LaneName {
  return typeof value === "string" && LANE_PATTERN.test(value);
}

export function parseLaneName(value: unknown): LaneName {
  if (!isLaneName(value)) {
    throw new Error(
      `invalid lane name ${JSON.stringify(value)}: use lowercase letters, digits and hyphens, at most 32 characters`,
    );
  }
  return value;
}
