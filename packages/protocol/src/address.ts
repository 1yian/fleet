const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_AND_PORT = /^[^\s/?#:]+:[0-9]+(?:[/?#]|$)/;

export function checkedUrl(url: string | undefined): string {
  if (url === undefined || url === "") throw new Error("open needs a url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is not a full http or https address`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error(`only http and https pages can be opened, not ${parsed.protocol}`);
  return parsed.toString();
}

export function addressTyped(typed: string): string {
  const text = typed.trim();
  return HAS_SCHEME.test(text) && !HOST_AND_PORT.test(text) ? text : `https://${text}`;
}
