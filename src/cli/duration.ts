export function parseDuration(text: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(text.trim());
  if (!match) throw new Error(`invalid duration ${JSON.stringify(text)}: use 45s, 30m or 2h`);
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  return value * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
}
