import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { optionalString, parseRecord } from "./json.ts";

export interface Posted {
  readonly username: string;
  readonly password: string;
  readonly code: string;
}

const MONOSPACE = "<style>html, body, input { font-family: monospace; }</style>";

const withFont = (page: string): string => page.replace("</title>", `</title>${MONOSPACE}`);

const PAGES: Readonly<Record<string, string>> = {
  "/a": `<!doctype html><title>Alpha</title><body data-owner="a">
    <p>alpha page</p>
    <button id="count" style="position:fixed;left:20px;top:60px;width:200px;height:80px" onclick="document.getElementById('n').textContent = String(Number(document.getElementById('n').textContent) + 1)">count</button>
    <span id="n" style="position:fixed;left:20px;top:160px">0</span>
    <input id="q" style="position:fixed;left:20px;top:200px;width:200px;height:30px">
  </body>`,
  "/b": `<!doctype html><title>Bravo</title><body data-owner="b"><p>bravo page</p></body>`,
  "/popup": `<!doctype html><title>Popup</title><body>
    <a id="blank" target="_blank" href="/b" style="position:fixed;left:20px;top:20px">open b</a>
    <p>popup page</p></body>`,
  "/login": `<!doctype html><title>Sign in</title><body>
    <form id="form" action="/session" method="post" onsubmit="event.preventDefault(); fetch('/session', { method: 'POST', body: JSON.stringify({ username: this.u.value, password: this.p.value, code: this.c.value }) }).then(() => { document.title = 'Signed in'; document.getElementById('msg').textContent = 'Welcome back'; })">
      <input name="u" type="text" autocomplete="username">
      <input name="p" type="password" autocomplete="current-password">
      <input name="c" type="text" autocomplete="one-time-code" placeholder="code">
      <button id="reveal" type="button" onclick="const p = this.form.p; p.type = p.type === 'password' ? 'text' : 'password'">show</button>
      <button id="submit" type="submit">Sign in</button>
    </form><p id="msg"></p></body>`,
  "/echo": `<!doctype html><title>Echo</title><body>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="document.getElementById('u-echo').textContent = this.value">
      <input name="p" type="password" autocomplete="current-password" oninput="document.getElementById('p-echo').textContent = this.value">
    </form>
    <p id="u-echo"></p><p id="p-echo"></p></body>`,
  "/sso": `<!doctype html><title>Single sign-on</title><body>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="setTimeout(() => { location.href = location.href.replace('login.example.test', 'login.evil.test').replace('/sso', '/landing') }, 0)">
      <input name="p" type="password" autocomplete="current-password">
    </form></body>`,
  "/landing": `<!doctype html><title>Landing</title><body>
    <input name="q" type="text" autofocus></body>`,
  "/nest": `<!doctype html><title>Nest</title><body>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="show(this.value, this.value)">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <div id="shadow"></div>
    <iframe id="same" style="width:320px;height:60px"></iframe>
    <iframe id="cross" style="width:320px;height:60px"></iframe>
    <script>
      const root = document.getElementById("shadow").attachShadow({ mode: "open" });
      root.innerHTML = "<p></p><input>";
      const loaded = (frame, url) => new Promise((resolve) => { frame.onload = () => resolve(); frame.src = url; });
      window.show = (text, field) => {
        root.querySelector("p").textContent = text;
        root.querySelector("input").value = field;
        const path = "/account?as=" + encodeURIComponent(text);
        const other = location.origin.replace("login.example.test", "login.nothing.test");
        window.framesReady = Promise.all([
          loaded(document.getElementById("same"), path),
          loaded(document.getElementById("cross"), other + path),
        ]);
        return window.framesReady;
      };
    </script></body>`,
  "/split": `<!doctype html><title>Split</title><body>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="show(this.value)">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <p id="who"></p>
    <script>
      window.show = (text) => {
        const first = Math.floor(text.length / 3);
        const second = Math.floor((text.length * 2) / 3);
        const strong = document.createElement("strong");
        strong.textContent = text.slice(first, second);
        document.getElementById("who").replaceChildren(text.slice(0, first), strong, text.slice(second));
      };
    </script></body>`,
  "/tick": `<!doctype html><title>Tick</title><body>
    <form>
      <input name="u" type="text" autocomplete="username">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <p id="who"></p>
    <script>
      let current = "";
      document.querySelector("[name=u]").addEventListener("input", (event) => { current = event.target.value; });
      const shown = (text) => new Promise((resolve) => {
        const check = () => (document.getElementById("who").textContent === text ? resolve("ready") : setTimeout(check, 5));
        check();
      });
      window.shown = shown;
      window.set = (text) => {
        current = text;
        return shown(text);
      };
      setInterval(() => { document.getElementById("who").replaceChildren(document.createTextNode(current)); }, 10);
    </script></body>`,
  "/tall": `<!doctype html><title>Tall</title><body>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="document.getElementById('who').textContent = this.value">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <div style="height:1400px"></div>
    <p id="who"></p></body>`,
  "/slide": `<!doctype html><title>Slide</title><body>
    <style>@keyframes slide { from { margin-left: 0 } to { margin-left: 1000000px } }</style>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="const who = document.getElementById('who'); who.textContent = this.value; who.style.animation = 'slide 100s linear forwards'">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <p id="who"></p></body>`,
  "/pseudo": `<!doctype html><title>Pseudo</title><body>
    <style>#who::before { content: attr(data-account); }</style>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="document.getElementById('who').setAttribute('data-account', this.value)">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <span id="who" data-account=""></span></body>`,
  "/closed": `<!doctype html><title>Closed</title><body>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="window.hold(this.value)">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <div id="host"></div>
    <script>
      const root = document.getElementById("host").attachShadow({ mode: "closed" });
      root.innerHTML = "<p></p>";
      window.hold = (text) => { root.querySelector("p").textContent = text; };
    </script></body>`,
  "/fragile": `<!doctype html><title>Fragile</title><body>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="document.getElementById('u-echo').textContent = this.value; this.form.p.remove()">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <p id="u-echo"></p></body>`,
};

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

export class TestSite {
  readonly posted: Posted[];
  readonly port: number;
  private readonly server: Server;

  private constructor(server: Server, port: number, posted: Posted[]) {
    this.server = server;
    this.port = port;
    this.posted = posted;
  }

  static async start(): Promise<TestSite> {
    const posted: Posted[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://site").pathname;
      if (request.method === "POST" && path === "/session") {
        void bodyOf(request).then((body) => {
          const sent = parseRecord(body);
          posted.push({
            username: optionalString(sent, "username") ?? "",
            password: optionalString(sent, "password") ?? "",
            code: optionalString(sent, "code") ?? "",
          });
          response.writeHead(204).end();
        });
        return;
      }
      if (path === "/account") {
        const who = new URL(request.url ?? "/", "http://site").searchParams.get("as") ?? "";
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(
            withFont(
              `<!doctype html><title>Account of ${who}</title><body><p id="who">${who}</p></body>`,
            ),
          );
        return;
      }
      const page = PAGES[path];
      if (page === undefined) response.writeHead(404).end();
      else
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(withFont(page));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") throw new Error("no site address");
    return new TestSite(server, address.port, posted);
  }

  url(path: string, host = "127.0.0.1"): string {
    return `http://${host}:${String(this.port)}${path}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
