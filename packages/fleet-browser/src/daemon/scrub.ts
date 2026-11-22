const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$/i;

type Headers = Record<string, unknown>;

function scrubHeaders(headers: unknown): void {
  if (typeof headers !== "object" || headers === null) return;
  for (const key of Object.keys(headers as Headers)) {
    if (SENSITIVE_HEADER.test(key)) (headers as Headers)[key] = "[redacted]";
  }
}

const NETWORK_EVENT =
  /"method":"(Network\.(requestWillBeSent|requestWillBeSentExtraInfo|responseReceived|responseReceivedExtraInfo)|Fetch\.requestPaused)"/;

export function scrubNetworkEvent(text: string): string {
  if (!text.includes('"method":"') || !NETWORK_EVENT.test(text)) return text;
  const message = JSON.parse(text) as { method: string; params?: Record<string, unknown> };
  const params = message.params;
  if (!params) return text;
  const request = params.request as Record<string, unknown> | undefined;
  const response = params.response as Record<string, unknown> | undefined;
  if (request) {
    scrubHeaders(request.headers);
    delete request.postData;
    delete request.postDataEntries;
  }
  if (response) scrubHeaders(response.headers);
  scrubHeaders(params.headers);
  if ("associatedCookies" in params) params.associatedCookies = [];
  if ("blockedCookies" in params) params.blockedCookies = [];
  return JSON.stringify(message);
}
