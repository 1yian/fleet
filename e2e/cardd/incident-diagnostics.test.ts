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
      /: \[(?:YAML|curl|URL) withheld: credential boundaries unclear\]\. Classified unknown\./,
    );
    assert.doesNotMatch(heard.body, /paper|canoe|shared|harbor|99999/);
  });
}
