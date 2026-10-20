-- Session tokens derive from this key: the token is the HMAC-SHA256 of the
-- session ID. A dispatch retry can then hand out the same token again without
-- storing any token.
CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  value BLOB NOT NULL
) STRICT;
