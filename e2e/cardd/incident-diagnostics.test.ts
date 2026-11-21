import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { Session } from "../support/cardd.ts";
import { newCard, startFleet, type Fleet } from "../support/fleet.ts";
import { is, reportFailure } from "../support/incidents.ts";

let fleet: Fleet;
let cleo: Session;
beforeEach(async () => {
  fleet = await startFleet({ CARDD_TIMING_SCALE: "0.001" });
  cleo = await fleet.cardd.connect(fleet.cardd.addLane("cleo", "main"));
});
afterEach(async () => {
  await fleet.cardd.stop();
});

test("a runtime failure tells the mate the revision without disclosing credentials", async () => {
  const card = await newCard(cleo, "Identify the failing revision");
  await reportFailure(
    fleet,
    cleo,
    card,
    "Revision 0123456789abcdef0123456789abcdef01234567, fedcba9876543210fedcba9876543210fedcba98, ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef, ops@example.com, https://user:pass@example.com\r\n  password: # CI\r\n    Basic paper\r\n    canoe harbor\r\n  \"token\":\r\n    # generated\r\n    river sail\r\n  'client_secret': |2- # fixture\r\n    paper: canoe\r\n    # harbor\r\n  access_token: >+\r\n    river sail\r\n\r\n    harbor\r\n  'refresh_token': 'paper''canoe'\r\n  api_key: 'river\\'\r\n  reply: {secret: 'paper''canoe', next: visible, 'token': 'river\\'}\r\n  logs: [secret: 'paper''canoe', next: visible, 'token': 'river\\']\r\n  data: [{password: !!str 'a''b', keep: yes}, token: !<tag:yaml.org,2002:str> paper canoe, ok]\r\n  password: !!str |\r\n    paper: canoe\r\n  token: !!str \"river \\\"sail\"\r\n  next: visible",
  );
  const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
  assert.ok(
    heard.body.includes(
      "Revision 0123456789abcdef0123456789abcdef01234567, [hidden], [hidden], [hidden], https://[hidden]@example.com password: [hidden] \"token\": [hidden] 'client_secret': [hidden] access_token: [hidden] 'refresh_token': [hidden] api_key: [hidden] reply: {secret: [hidden], next: visible, 'token': [hidden]} logs: [secret: [hidden], next: visible, 'token': [hidden]] data: [{password: [hidden], keep: yes}, token: [hidden], ok] password: [hidden] token: [hidden] next: visible",
    ),
    heard.body,
  );
});

for (const [diagnostic, visible] of [
  [
    'Connection https://build:paper`"<>canoe@localhost/api',
    "Connection https://[hidden]@localhost/api",
  ],
  ["\uFEFFpassword: paper canoe\nnext: visible", "password: [hidden] next: visible"],
  ["password: |-\r paper canoe\rnext: yes", "password: [hidden] next: yes"],
  [
    String.raw`Tool returned {"na\u006de":"visible"}`,
    String.raw`Tool returned {"na\u006de":"visible"}`,
  ],
] as const) {
  test(`a runtime failure shows ${visible} without the original credential`, async () => {
    const card = await newCard(cleo, "Report a failing diagnostic");
    await reportFailure(fleet, cleo, card, diagnostic);
    const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
    assert.ok(heard.body.includes(`${visible}. Classified unknown.`), heard.body);
    assert.doesNotMatch(heard.body, /paper|canoe/);
  });
}

for (const [name, diagnostic] of [
  ["tag and anchor", "token: &shared !!str >\n paper: canoe\nnext: yes"],
  ["credential alias", "{label: &shared 'paper canoe', token: *shared}"],
  ["nested block", "- - token: >-\n     paper canoe\n     harbor\n    next: yes"],
  ["nested plain scalar", "- - token: paper canoe\n     harbor\n    next: yes"],
  ["flow collection", '{"token":["paper",{"retry_after":99999,"part":"canoe"}]}'],
  ["block collection", "token:\n  part: paper\n  rest: canoe\nnext: yes"],
  ["indentless sequence", "token:\n- paper\n- canoe\nnext: yes"],
  ["BOM-prefixed indentless sequence", "\uFEFFtoken:\n- paper\n- canoe\nnext: yes"],
  ["marker in a collection", "{token: [hidden, paper, canoe], next: yes}"],
  ["invalid status envelope", "429 Too Many Requests. Retry-After: 99999 token: [paper, canoe]"],
  ["mismatched status reason", "HTTP 502 Payment Required\nSessionToken: [paper, canoe]"],
  ["merge key", "defaults: &shared\n  note: paper canoe\nsettings:\n  <<: *shared"],
  ["truncated quoted value", 'Tool returned {"password":"paper canoe'],
  ["truncated shell value", 'password="paper canoe'],
  ["escaped credential key", String.raw`{"pass\u0077ord":"paper canoe"}`],
  ["escaped credential key with a space", String.raw`{"api\u0020key":"paper canoe"}`],
  ["partially quoted shell value", 'password=prefix"paper canoe'],
  ["unterminated fleet token option", '--fleet-token "paper canoe'],
  ["structured prefix before a quote", 'Tool printed password: prefix"paper canoe'],
  ["spliced prefix before a quote", 'Tool printed password=pre\\\nfix"paper canoe'],
  ["unterminated backtick fleet token", "--fleet-token `paper canoe"],
  ["unterminated backtick shell value", "password=`paper canoe"],
  ["attached backtick structured value", "Tool printed password: prefix`paper canoe"],
  ["attached backtick shell value", "Tool printed password=prefix`paper canoe"],
  ["spliced attached backtick value", "Tool printed password=pre\\\nfix`paper canoe"],
  ["spliced credential collection", "Tool printed pass\\\nword: [paper, canoe]"],
  ["spliced escaped credential key", 'Tool printed {"pass\\\n\\u0077ord":"paper canoe"}'],
  ["spliced unbounded YAML", "Tool printed to\\\nken: !!str >\n paper canoe"],
  ["spliced multiline scalar", "pass\\\nword: paper\n  canoe"],
  ["spliced authorization scalar", "Auth\\\norization: paper\n  canoe"],
  ["spliced prefixed authorization scalar", "x_Auth\\\norization: paper\n  canoe"],
  ["spliced authorization scheme tail", "Auth\\\norization: Basic paper\n  canoe"],
  ["spliced prefixed bearer tail", "x_Auth\\\norization: Bearer paper\n  canoe"],
  ["spliced scalar value", "password: pa\\\nper\n  canoe"],
  ["spliced URL userinfo", "Git printed https://build:pa@ss\\\nword@localhost/path"],
  ["spliced unterminated value", 'Tool printed password=\\\n"paper canoe'],
  ["escaped credential key collection", String.raw`{"pass\u0077ord":["paper","canoe"]}`],
  ["curl credential option", "curl -u 'demo:paper canoe' https://localhost"],
  ["curl flag-shaped output file", "curl -o -u 'demo:paper canoe' https://localhost"],
  ["curl quoted credential option", "curl '-u' 'demo:paper canoe' https://localhost"],
  ["curl proxy credential option", "curl --proxy-user 'build:paper-canoe' https://localhost"],
  ["curl proxy credential short option", "curl -U 'build:paper-canoe' https://localhost"],
  ["curl oauth2 bearer option", "curl --oauth2-bearer tok123 https://localhost"],
  ["curl attached oauth2 bearer option", "curl --oauth2-bearer=tok123 https://localhost"],
  ["curl custom authorization header", "curl -H 'Authorization: Custom abc' https://localhost"],
  ["curl named api key header", "curl -H 'X-Api-Key: paper canoe' https://localhost"],
  ["curl named token header", 'curl -H "X-Auth-Token: paper canoe" https://localhost'],
  ["curl attached named header", "curl -H'X-Api-Key: paper canoe' https://localhost"],
  ["curl escaped-space header", "curl -H X-Api-Key:paper\\ canoe https://localhost"],
  ["curl compound-quoted header", "curl -H 'X-Ap'i-Key:'paper canoe' https://localhost"],
  ["curl grouped header option", "curl -sH X-Auth-Token:paper\\ canoe https://localhost"],
  ["curl basic header with a tail", "curl -H 'Authorization: Basic paper canoe' https://localhost"],
  ["curl hidden marker with a tail", "curl -H 'X-Api-Key: [hidden] canoe' https://localhost"],
  ["curl form password argument", "curl --data-urlencode 'password=paper canoe' https://localhost"],
  ["curl json body password", `curl -d '{"password":"paper canoe"}' https://localhost`],
  ["curl key passphrase", "curl --cert client.pem --pass paper https://localhost"],
  ["curl attached certificate password", "curl -E client.pem:paper https://localhost"],
  ["curl tls password", "curl --tlspassword paper --tlsuser demo https://localhost"],
  ["curl multipart secret", "curl -F 'client_secret=paper canoe' https://localhost"],
  ["curl attached data argument", "curl -d'password=paper canoe' https://localhost"],
  ["curl percent-encoded field name", "curl -d 'pass%77ord=paper%20canoe' https://localhost"],
  ["curl form-encoded short data", "curl -d 'a%70i+key=paper' https://localhost"],
  ["curl form-encoded long data", "curl --data-raw 'a%70i+key=paper' https://localhost"],
  ["curl form-encoded raw url query", "curl --url-query 'client+secret=paper' https://localhost"],
  [
    "curl percent-encoded url query",
    "curl --url-query 'pass%77ord=paper%20canoe' https://localhost",
  ],
  [
    "curl grouped data argument",
    "curl -sd 'user=demo name&password=paper canoe' https://localhost",
  ],
  ["curl cookie option", "curl --cookie 'session=paper' https://localhost"],
  ["curl short cookie option", "curl -b 'session=paper' https://localhost"],
  ["curl cookie header", "curl -H 'Cookie: session=paper' https://localhost"],
  ["curl ANSI-C cookie header", "curl -H $'Cookie: session=paper' https://localhost"],
  ["curl ANSI-C option word", "curl $'-b' 'session=paper' https://localhost"],
  ["curl bare variable header", 'curl -H "$header: session=paper" https://localhost'],
  ["curl scheme-less host first", 'curl localhost -H "$header: session=paper"'],
  ["raw request cookie header", "GET / HTTP/1.1\nHost: localhost\nCookie: session=paper"],
  ["raw response set-cookie header", "HTTP/1.1 200 OK\nSet-Cookie: session=paper; HttpOnly"],
  ["spliced cookie header name", "Co\\\nokie: session=paper"],
  ["cookie with a hidden prefix", "Cookie: [hidden]; session=paper"],
  ["escaped cookie key", String.raw`Headers {"Co\u006fkie":"session=paper"}`],
  ["cookie2 header", "Cookie2: session=paper"],
  ["serialized transcript cookie", String.raw`{"trace":"GET / HTTP/1.1\r\nCookie: session=paper"}`],
  ["serialized header pair", String.raw`headers [["Cookie","session=paper"]]`],
  ["HAR header record", String.raw`[{"name":"Cookie","value":"sid=paper"}]`],
  [
    "HAR authorization record",
    String.raw`[{"name":"Authorization","value":"Basic cGFwZXI6Y2Fub2U="}]`,
  ],
  [
    "HAR reversed proxy authorization",
    String.raw`[{"value":"Basic cGFwZXI6Y2Fub2U=","name":"Proxy-Authorization"}]`,
  ],
  ["native cookies array", String.raw`{"request":{"cookies":[{"name":"sid","value":"paper"}]}}`],
  [
    "HAR header record with reversed order",
    String.raw`[{"value":"sid=paper","name":"Set-Cookie"}]`,
  ],
  [
    "curl proxy header",
    "curl --proxy-header 'Proxy-Authorization: Custom paper' https://localhost",
  ],
  ["nested serialized header pair", String.raw`{"headers":"[[\"Cookie\",\"session=paper\"]]"}`],
  [
    "doubly nested header pair",
    String.raw`{"headers":"[[\\\"Set-Cookie2\\\",\\\"session=paper\\\"]]"}`,
  ],
  ["curl backtick header name", "curl -H `echo Cookie`: session=paper https://localhost"],
  ["curl ANSI-C user option", "curl $'--user' 'demo:paper canoe' https://localhost"],
  ["curl http 1.0 proxy login", "curl --proxy1.0 build:paper@proxy:8080 https://localhost"],
  ["curl http 1.0 proxy equals login", "curl --proxy1.0=build:paper@proxy:8080 https://localhost"],
  ["curl unknown proxy option", "curl --proxy-future-option build:paper@proxy https://localhost"],
  ["curl unproven userinfo", "curl https://localhost build:paper@proxy:8080"],
  ["curl attached proxy login", "curl -xbuild:paper@proxy:8080 https://localhost"],
  ["curl grouped proxy login", "curl -sxbuild:paper@proxy:8080 https://localhost"],
  ["curl scheme-less proxy login", "curl -x build:paper@proxy:8080 https://localhost"],
  ["curl redirection boundary", "curl</dev/null -u 'demo:paper canoe' https://localhost"],
  ["curl spliced executable name", "cu\\\nrl -u 'demo:paper canoe' https://localhost"],
  ["spliced URL authority", "curl https://build:paper\\\ncanoe@localhost/api"],
  ["quote-spliced URL authority", "curl 'https://build:'paper\\\ncanoe@localhost/api"],
  ["curl spliced credential option", "curl --us\\\ner 'demo:paper canoe' https://localhost"],
] as const) {
  test(`a runtime failure with a YAML ${name} withholds the diagnostic`, async () => {
    const card = await newCard(cleo, "Report a failing diagnostic");
    await reportFailure(fleet, cleo, card, diagnostic);
    const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
    assert.match(
      heard.body,
      /: \[(?:YAML|curl|URL|credential record) withheld: credential boundaries unclear\]\. Classified (?:unknown|withheld)\./,
    );
    assert.doesNotMatch(heard.body, /paper|canoe|shared|harbor|99999/);
  });
}

for (const [name, diagnostic] of [
  ["a HAR cookie record", String.raw`[{"value":"sid=paper","name":"Cookie"}]`],
  ["a raw cookie header", "Cookie: session=paper"],
  ["a native cookies array", String.raw`{"cookies":[{"name":"sid","value":"paper"}]}`],
  [
    "a serialized authorization header",
    String.raw`{"trace":"GET / HTTP/1.1\r\nAuthorization: Basic cGFwZXI6Y2Fub2U="}`,
  ],
  ["a serialized api key header", String.raw`{"trace":"GET / HTTP/1.1\r\nX-Api-Key: paper"}`],
  [
    "a unicode-escaped line break before authorization",
    String.raw`{"trace":"GET / HTTP/1.1\u000d\u000aAuthorization: Basic cGFwZXI6Y2Fub2U="}`,
  ],
  ["a verbose digest authorization", '> Authorization: Digest username="demo", response="paper"'],
  ["a verbose api key header", "> X-Api-Key: paper"],
  [
    "a timestamped wrapped trace authorization",
    "15:16:17.123456 0000: GET / HTTP/1.1\n15:16:17.123457 003a: Authorization: Basic cGFwZXI6Y2Fub2VwYXBlcjpjYW5vZXBhcGVy\n15:16:17.123458 007a: Y2Fu",
  ],
  [
    "a serialized wrapped trace authorization",
    String.raw`{"trace":"0000: GET / HTTP/1.1\r\n003a: Authorization: Basic cGFwZXI6Y2Fub2VwYXBlcjpjYW5vZXBhcGVy\r\n007a: Y2Fu"}`,
  ],
  [
    "a trace-ascii header name split across rows",
    "0000: GET / HTTP/1.1\n0040: Host: localhost\r\nAuthoriz\n0080: ation: Basic cGFwZXI6Y2Fub2U=",
  ],
  [
    "a serialized single trace row",
    String.raw`{"trace":"0000: 43 6f 6f 6b 69 65 3a 20 73 69 64 3d 70 61 70 65 72"}`,
  ],
  ["an inline-code trace row", "`0000: 43 6f 6f 6b 69 65 3a 20 73 69 64 3d 70 61 70 65 72`"],
  ["an indented trace row", "    0000: 43 6f 6f 6b 69 65 3a 20 73 69 64 3d 70 61 70 65 72"],
  [
    "a serialized clipped cookie tail with a retained terminator",
    String.raw`{"trace":"15:16:17.000001 0040: abc; sid=paper\r\n15:16:17.000002 0050: "}`,
  ],
  [
    "a clipped cookie tail with an internal space and a retained terminator",
    "15:16:17.000001 0040: abc; sid=paper\n15:16:17.000002 0050: ",
  ],
  [
    "a clipped cookie tail with an internal space and a trimmed terminator",
    String.raw`{"trace":"15:16:17.000001 0040: abc; sid=paper\r\n15:16:17.000002 0050:"}`,
  ],
  [
    "a timestamped clipped cookie tail and terminating row",
    String.raw`{"trace":"15:16:17.000001 0040: abc.def\r\n15:16:17.000002 0049: "}`,
  ],
  [
    "timestamped short clipped trace rows",
    String.raw`{"trace":"15:16:17.000001 0040: Y2Fu\r\n15:16:17.000002 0046: Y2Fu"}`,
  ],
  [
    "clipped trace continuation rows",
    "0040: Y2FuY2FuY2FuY2FuY2FuY2FuY2FuY2FuY2FuY2FuY2FuY2FuY2FuY2FuY2FuY2Fu\n0080: Y2Fu",
  ],
  ["a trace hex dump", "0000: 47 45 54 20 2f 20 48 54 54 50 2f 31 2e 31 20 70 61 70 65 72"],
  [
    "a wrapped trace-ascii authorization",
    "0000: GET / HTTP/1.1\n003a: Authorization: Basic cGFwZXI6Y2Fub2VwYXBlcjpjYW5vZXBhcGVy\n007a: Y2Fu",
  ],
  [
    "an inline digest authorization",
    'The trace printed Authorization: Digest username="demo", response="paper".',
  ],
  ["an inline negotiate authorization", "The trace printed Authorization: Negotiate paper canoe."],
  [
    "an HTTP/2 bracketed header",
    '[HTTP/2] [1] [authorization: Digest username="demo", cnonce="paper"]',
  ],
  [
    "a transcript field starting with a credential header",
    String.raw`{"trace":"Authorization: Digest username=\"demo\", cnonce=\"paper\""}`,
  ],
  [
    "a cookie header beside a curl credential",
    "Cookie: session=paper\ncurl -u 'demo:paper canoe' https://localhost",
  ],
  [
    "a cookie header beside URL userinfo",
    "Cookie: session=paper\nhttps://demo:paper@localhost/path",
  ],
  ["a cookie header beside a YAML collection", "Cookie: session=paper\ntoken: [paper, canoe]"],
] as const) {
  test(`${name} without a trusted envelope is refused recovery through card.restart`, async () => {
    const card = await newCard(cleo, "Report a failing diagnostic");
    await reportFailure(fleet, cleo, card, diagnostic);
    const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
    assert.ok(heard.body.includes("Classified withheld."), heard.body);
    assert.doesNotMatch(heard.body, /paper/);
    await assert.rejects(
      cleo.call("card.restart", {
        card: card.id,
        incident: 1,
        generation: 1,
        mode: "retry",
        key: "withheld-retry",
      }),
      /is blocked/,
    );
  });
}

test("an Unauthorized report that only names a token field keeps its text, is classified auth, and is refused recovery", async () => {
  const card = await newCard(cleo, "Report an auth failure");
  await reportFailure(fleet, cleo, card, '{"message":"Unauthorized","field":"token"}');
  const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
  assert.ok(heard.body.includes('{"message":"Unauthorized","field":"token"}'), heard.body);
  assert.ok(heard.body.includes("Classified auth."), heard.body);
  await assert.rejects(
    cleo.call("card.restart", {
      card: card.id,
      incident: 1,
      generation: 1,
      mode: "retry",
      key: "auth-retry",
    }),
    /is blocked/,
  );
});

test("a host and port timeout keeps its text and its transient classification", async () => {
  const card = await newCard(cleo, "Report a network timeout");
  await reportFailure(fleet, cleo, card, "dial tcp 127.0.0.1:8080: i/o timeout");
  const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
  assert.ok(heard.body.includes("dial tcp 127.0.0.1:8080: i/o timeout"), heard.body);
  assert.ok(heard.body.includes("Classified transient."), heard.body);
  assert.ok(heard.body.includes("mode=retry"), heard.body);
});

for (const [name, diagnostic] of [
  ["backslash separators", String.raw`Browser URL https:\\demo:paper@localhost\api failed`],
  ["a tab inside userinfo", "Browser URL https://demo:pa\tper@localhost/api failed"],
  ["no authority separators", "Browser URL https:demo:paper@localhost/api failed"],
  ["excess authority separators", "Browser URL https:////demo:paper@localhost/api failed"],
  [
    "an encoded query parameter name",
    "Callback https://localhost/callback?access%5Ftoken=paper failed",
  ],
  [
    "a form-encoded query parameter name",
    "Callback https://localhost/callback?a%70i+key=paper failed",
  ],
  [
    "a plus-separated fragment parameter name",
    "Callback https://localhost/callback#client+secret=paper failed",
  ],
  [
    "an escaped ampersand before a parameter name",
    String.raw`{"url":"https://localhost/callback?next=1\u0026password=paper"}`,
  ],
  ["an escaped query opener", String.raw`{"url":"https://localhost/callback\u003fpassword=paper"}`],
  [
    "an escaped assignment separator",
    String.raw`{"url":"https://localhost/callback#next=1\u0026token\u003dpaper"}`,
  ],
  [
    "a plain URL before an escaped query opener",
    String.raw`{"a":"https://localhost/cb?password=example","b":"https://localhost/cb\u003fpassword=paper"}`,
  ],
  [
    "an escaped query opener before a plain URL",
    String.raw`{"b":"https://localhost/cb\u003fpassword=paper","a":"https://localhost/cb?password=example"}`,
  ],
  [
    "a skipped raw name before an escaped semicolon assignment",
    String.raw`{"a":"https://fixture.local/?x;password=example","b":"https://fixture.local/?next=1\u003bpassword=paper"}`,
  ],
  [
    "an escaped semicolon assignment before a skipped raw name",
    String.raw`{"b":"https://fixture.local/?next=1\u003bpassword=paper","a":"https://fixture.local/?x;password=example"}`,
  ],
  [
    "an escaped space inside a parameter name",
    String.raw`{"url":"https://localhost/callback?api\u0020key=paper"}`,
  ],
  [
    "an escaped tab inside a parameter name",
    String.raw`{"url":"https://localhost/callback?pass\u0009word=paper"}`,
  ],
  [
    "an escaped angle bracket in a quoted URL",
    String.raw`{"url":"https://localhost/cb?password=paper\u003c canoe"}`,
  ],
  [
    "a literal tab inside a parameter name",
    "Callback https://localhost/callback?pass\tword=paper failed",
  ],
  [
    "a single-slash browser URL with a tab inside a parameter name",
    "Callback https:/localhost/callback?pass\tword=paper failed",
  ],
  [
    "a literal tab inside a credential value",
    "Callback https://localhost/cb?password=pa\tper failed",
  ],
  [
    "an escaped tab inside a credential value",
    String.raw`{"url":"https://localhost/cb?password=pa\u0009per"}`,
  ],
  ["a Markdown join in a value", "See https://localhost/cb?password=pa](per"],
  [
    "a quoted URL with an interior space",
    String.raw`{"url":"https://localhost/cb?password=paper canoe\u0026next=yes"}`,
  ],
  [
    "an encoded fragment parameter name",
    "Callback https://localhost/callback#pass%77ord=paper failed",
  ],
  ["an escaped at sign", String.raw`{"url":"https:demo:paper\u0040localhost/api"}`],
] as const) {
  test(`a browser-equivalent URL with ${name} is withheld`, async () => {
    const card = await newCard(cleo, "Report a failing diagnostic");
    await reportFailure(fleet, cleo, card, diagnostic);
    const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
    assert.match(heard.body, /\[URL withheld: credential boundaries unclear\]/);
    assert.doesNotMatch(heard.body, /paper/);
  });
}

test("an escaped-name URL credential is withheld and refused recovery through card.restart", async () => {
  const card = await newCard(cleo, "Report an escaped credential name");
  await reportFailure(
    fleet,
    cleo,
    card,
    String.raw`Unauthorized for {"url":"https://localhost/callback?api\u0020key=paper"}`,
  );
  const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
  assert.ok(heard.body.includes("Classified withheld."), heard.body);
  assert.doesNotMatch(heard.body, /paper/);
  await assert.rejects(
    cleo.call("card.restart", {
      card: card.id,
      incident: 1,
      generation: 1,
      mode: "retry",
      key: "escaped-retry",
    }),
    /is blocked/,
  );
});

test("an unrelated Unicode escape keeps the plain URL credential scrubbed, the auth class, and the refusal", async () => {
  const card = await newCard(cleo, "Report an unrelated escape");
  await reportFailure(
    fleet,
    cleo,
    card,
    String.raw`Unauthorized for https://localhost/cb?password=paper (label \u00e9)`,
  );
  const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
  assert.ok(heard.body.includes("password=[hidden]"), heard.body);
  assert.ok(heard.body.includes("Classified auth."), heard.body);
  assert.doesNotMatch(heard.body, /paper/);
  await assert.rejects(
    cleo.call("card.restart", {
      card: card.id,
      incident: 1,
      generation: 1,
      mode: "retry",
      key: "unrelated-escape-retry",
    }),
    /is blocked/,
  );
});

test("a bare port diagnostic keeps its text and its transient recovery", async () => {
  const card = await newCard(cleo, "Report a port timeout");
  await reportFailure(fleet, cleo, card, "8080: i/o timeout");
  const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
  assert.ok(heard.body.includes("8080: i/o timeout"), heard.body);
  assert.ok(heard.body.includes("Classified transient."), heard.body);
  assert.ok(heard.body.includes("mode=retry"), heard.body);
});

test("two port-prefixed failure lines keep their text and their transient recovery", async () => {
  const card = await newCard(cleo, "Report two port failures");
  await reportFailure(fleet, cleo, card, "8080: i/o timeout\n9090: connection refused");
  const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
  assert.ok(heard.body.includes("8080: i/o timeout"), heard.body);
  assert.ok(heard.body.includes("Classified transient."), heard.body);
  assert.ok(heard.body.includes("mode=retry"), heard.body);
});

test("two port lines whose offsets match the first message length keep text and transient recovery", async () => {
  const card = await newCard(cleo, "Report matching-gap port failures");
  await reportFailure(fleet, cleo, card, "8080: network timeout\n8090: connection refused");
  const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
  assert.ok(heard.body.includes("8080: network timeout"), heard.body);
  assert.ok(heard.body.includes("Classified transient."), heard.body);
  assert.ok(heard.body.includes("mode=retry"), heard.body);
});

test("timestamped port lines whose offsets match the first message keep text and transient recovery", async () => {
  const card = await newCard(cleo, "Report timestamped matching-gap port failures");
  await reportFailure(
    fleet,
    cleo,
    card,
    "12:00:01.000001 8080: network timeout\n12:00:02.000002 8091: connection refused",
  );
  const heard = await cleo.waitForEntry(is("runtime-failure"), "the runtime failure");
  assert.ok(heard.body.includes("8080: network timeout"), heard.body);
  assert.ok(heard.body.includes("Classified transient."), heard.body);
  assert.ok(heard.body.includes("mode=retry"), heard.body);
});
