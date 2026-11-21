export const RECOVERY_SCOPE = [
  [
    "a proxy CONNECT success before an origin auth failure",
    "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 401\r\nSet-Cookie: session=paper\r\n\r\n",
    "blocked",
    /is blocked/,
  ],
  [
    "a proxy CONNECT success before an origin overload with a proxy retry hint",
    "HTTP/1.1 200 Connection established\r\nRetry-After: 99999\r\n\r\nHTTP/2 503\r\nRetry-After: 120\r\nSet-Cookie: session=paper\r\n\r\n",
    "delayed",
    /not eligible for recovery/,
  ],
  [
    "a proxy CONNECT success with malformed origin framing",
    "HTTP/1.1 200 Connection established\r\n\r\nSet-Cookie: session=paper\r\n\r\n",
    "blocked",
    /is blocked/,
  ],
  [
    "a direct success response with a withheld cookie",
    "HTTP/1.1 200 OK\r\nSet-Cookie: session=paper\r\n\r\n",
    "blocked",
    /is blocked/,
  ],
  [
    "a proxy CONNECT success before an origin success with a withheld cookie",
    "HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 200\r\nSet-Cookie: session=paper\r\n\r\n",
    "blocked",
    /is blocked/,
  ],
  [
    "an early-hints block before a final auth failure with a cookie",
    "HTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\n\r\nHTTP/1.1 401 Unauthorized\r\nSet-Cookie: session=paper\r\n\r\n",
    "blocked",
    /is blocked/,
  ],
  [
    "a continue block and a CONNECT block before a final delayed overload",
    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 Connection established\r\n\r\nHTTP/2 503\r\nRetry-After: 120\r\nSet-Cookie: session=paper\r\n\r\n",
    "delayed",
    /not eligible for recovery/,
  ],
  [
    "an interim block without a terminating blank line",
    "HTTP/1.1 103 Early Hints\r\nHTTP/1.1 401 Unauthorized\r\nSet-Cookie: session=paper\r\n\r\n",
    "blocked",
    /is blocked/,
  ],
  [
    "a browser-normalized escaped credential name",
    String.raw`{"url":"https://localhost/cb?pass\u0009word=paper"}`,
    "blocked",
    /is blocked/,
  ],
  [
    "an unrelated withheld curl command",
    "curl --user 'demo:paper canoe' https://localhost",
    "open",
  ],
] as const;
