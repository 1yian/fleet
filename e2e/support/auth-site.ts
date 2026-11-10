import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { optionalString, parseRecord } from "./json.ts";

export const PASSWORDS: Readonly<Record<string, string>> = {
  alice: "Synth-Alice-1234-fake",
  bob: "Synth-Bob-5678-fake",
};

const PAGE = `<!doctype html><title>Auth app</title><body style="font-family:monospace">
<p id="who">loading</p>
<p id="token"></p>
<form id="form">
  <input id="user" autocomplete="username">
  <input id="pass" type="password" autocomplete="current-password">
  <button id="go" type="submit">Sign in</button>
</form>
<textarea id="draft"></textarea>
<script>
  const show = async () => {
    const me = await (await fetch("/me")).json();
    document.getElementById("who").textContent = me.user ?? "signed out";
    document.getElementById("token").textContent = localStorage.getItem("token") ?? "";
  };
  document.getElementById("form").onsubmit = async (event) => {
    event.preventDefault();
    const user = document.getElementById("user").value;
    const password = document.getElementById("pass").value;
    const answer = await fetch("/signin", { method: "POST", body: JSON.stringify({ user, password }) });
    if (answer.ok) localStorage.setItem("token", (await answer.json()).token);
    await show();
  };
  const draft = document.getElementById("draft");
  draft.value = sessionStorage.getItem("draft") ?? "";
  draft.oninput = () => sessionStorage.setItem("draft", draft.value);
  show();
</script></body>`;

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      resolve(body);
    });
    request.on("error", reject);
  });
}

const cookieOf = (request: IncomingMessage, name: string): string | undefined =>
  (request.headers.cookie ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export class AuthSite {
  readonly port: number;
  private readonly server: Server;
  private readonly seen: string[];

  private constructor(server: Server, port: number, seen: string[]) {
    this.server = server;
    this.port = port;
    this.seen = seen;
  }

  static async start(): Promise<AuthSite> {
    const sessions = new Map<string, string>();
    const seen: string[] = [];
    const server = createServer((request, response) => {
      void answer(request, response, sessions, seen);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the site has no port");
    return new AuthSite(server, address.port, seen);
  }

  url(path: string): string {
    return `http://auth.example.test:${String(this.port)}${path}`;
  }

  get origin(): string {
    return this.url("");
  }

  get signins(): string[] {
    return [...this.seen];
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve();
      }),
    );
  }
}

type Reply = (request: IncomingMessage, response: ServerResponse, url: URL) => void;

function signIn(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, string>,
  seen: string[],
): Promise<void> {
  return bodyOf(request).then((body) => {
    const sent = parseRecord(body);
    const user = optionalString(sent, "user") ?? "";
    if (PASSWORDS[user] === undefined || PASSWORDS[user] !== optionalString(sent, "password")) {
      response.writeHead(401).end();
      return;
    }
    seen.push(user);
    const sid = randomBytes(12).toString("hex");
    sessions.set(sid, user);
    response
      .writeHead(200, {
        "content-type": "application/json",
        "set-cookie": [
          `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=3600`,
          "pref=dark; Path=/; Max-Age=3600",
          "lang=en; Domain=example.test; Path=/; Max-Age=3600",
        ],
      })
      .end(JSON.stringify({ token: `tok-${user}-${randomBytes(4).toString("hex")}` }));
  });
}

const PAGES: Readonly<Record<string, Reply>> = {
  "/pref": (_request, response, url) => {
    response
      .writeHead(204, {
        "set-cookie": `pref=${url.searchParams.get("v") ?? ""}; Path=/; Max-Age=3600`,
      })
      .end();
  },
  "/": (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  },
};

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  sessions: Map<string, string>,
  seen: string[],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://site");
  if (request.method === "POST" && url.pathname === "/signin") {
    await signIn(request, response, sessions, seen);
    return;
  }
  if (url.pathname === "/me") {
    const sid = cookieOf(request, "sid");
    const user = sid === undefined ? null : (sessions.get(sid) ?? null);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ user }));
    return;
  }
  const page = PAGES[url.pathname];
  if (page === undefined) response.writeHead(404).end();
  else page(request, response, url);
}
