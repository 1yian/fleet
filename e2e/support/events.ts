import { isRecord, optionalString } from "./json.ts";

export interface Seen {
  readonly method: string;
  readonly params: unknown;
}

export const eventOf = (
  events: readonly Seen[],
  method: string,
  after: number,
  path: string,
): Seen | undefined =>
  events.slice(after).find((event) => {
    const request = isRecord(event.params) ? event.params["request"] : undefined;
    const url = isRecord(request) ? optionalString(request, "url") : undefined;
    return event.method === method && url?.endsWith(path) === true;
  });

export const requestIdOf = (event: Seen): string =>
  isRecord(event.params) ? (optionalString(event.params, "requestId") ?? "") : "";

export function bodyOf(event: Seen): unknown {
  const request = isRecord(event.params) ? event.params["request"] : undefined;
  return isRecord(request) ? [request["postData"], request["postDataEntries"]] : undefined;
}
