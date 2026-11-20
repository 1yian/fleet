const KNOWN_REASON = String.raw`(?:too many requests|rate limit exceeded|overloaded|service (?:temporarily )?unavailable|unauthorized|forbidden|payment required|internal server error|bad gateway|gateway timeout)`;

export const VERSIONED_ENVELOPE = new RegExp(
  String.raw`^HTTP/\d(?:\.\d)?[ \t]+(\d{3})[ \t]+(?!${KNOWN_REASON}\b)[^\r\n]*(?=\r?\n)`,
  "i",
);
