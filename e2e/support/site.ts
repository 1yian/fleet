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
  "/links": `<!doctype html><title>Links</title><body><a id="next" href="/b" style="position:fixed;left:20px;top:20px">to bravo</a><button id="stay" style="position:fixed;left:20px;top:80px">stay</button><a id="fragment" href="#section" style="position:fixed;left:20px;top:140px">to section</a><button id="push" style="position:fixed;left:20px;top:200px" onclick="history.pushState({}, '', '/pushed')">push</button></body>`,
  "/composed": `<!doctype html><title>Composed</title><body><div id="who">hun<mark>ter</mark>2</div></body>`,
  "/copy": `<!doctype html><title>Copy</title><body><div id="who">S3cret&copy;2026</div></body>`,
  "/copy-attribute": `<!doctype html><title>Attribute</title><body><input id="who" value="S3cret&copy;2026"></body>`,
  "/copy-padded": `<!doctype html><title>Padded</title><body><div id="who">S3cret&#000000169;2026</div></body>`,
  "/copy-single": `<!doctype html><title>Single</title><body><div id="who">&#26446;</div></body>`,
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
  "/portal": `<!doctype html><title>Portal</title><body>
    <form id="form" onsubmit="event.preventDefault(); fetch('/session', { method: 'POST', body: JSON.stringify({ username: this.u.value, password: this.p.value, code: '' }) }).then(() => { location.href = '/landing'; })">
      <input name="u" type="text" autocomplete="username" oninput="document.getElementById('u-echo').textContent = this.value">
      <input name="p" type="password" autocomplete="current-password" oninput="document.getElementById('p-echo').textContent = this.value">
      <button id="submit" type="submit">Sign in</button>
    </form>
    <p id="u-echo"></p><p id="p-echo"></p></body>`,
  "/tint-portal": `<!doctype html><title>Tinted portal</title><body style="margin:0;height:100vh;background:#e00000">
    <form id="form" onsubmit="event.preventDefault(); fetch('/session', { method: 'POST', body: JSON.stringify({ username: this.u.value, password: this.p.value, code: '' }) }).then(() => { location.href = '/tint-landing'; })">
      <input name="u" type="text" autocomplete="username" oninput="document.getElementById('u-echo').textContent = this.value">
      <input name="p" type="password" autocomplete="current-password" oninput="document.getElementById('p-echo').textContent = this.value">
      <button id="submit" type="submit">Sign in</button>
    </form>
    <p id="u-echo"></p><p id="p-echo"></p></body>`,
  "/tint-landing": `<!doctype html><title>Tinted landing</title><body style="margin:0;height:100vh;background:#0000e0"><p>landed</p></body>`,
  "/tint-other": `<!doctype html><title>Tinted other</title><body style="margin:0;height:100vh;background:#00b000"><p>other</p></body>`,
  "/steps": `<!doctype html><title>Steps</title><body>
    <form id="one" onsubmit="event.preventDefault()">
      <input name="u" type="text" autocomplete="username">
      <button id="next" type="button" onclick="document.getElementById('one').replaceWith(Object.assign(document.createElement('p'), { id: 'two', textContent: 'step two' }))">Next</button>
    </form></body>`,
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
  "/places": `<!doctype html><title>Places</title><body>
    <style>
      #attr::before { content: attr(data-account); }
      #after::after { content: attr(data-tail); }
    </style>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="put(this.value)">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <div id="spot"></div>
    <script>
      const spot = document.getElementById("spot");
      const loaded = (frame, url) => new Promise((resolve) => { frame.onload = () => resolve(); frame.src = url; });
      const framed = (host) => (text) => {
        const frame = document.createElement("iframe");
        spot.replaceChildren(frame);
        const origin = host === "" ? "" : location.origin.replace("login.example.test", host);
        return loaded(frame, origin + "/account?as=" + encodeURIComponent(text));
      };
      const roots = {};
      const rooted = (mode) => (text) => {
        roots[mode] ??= (() => {
          const holder = document.createElement("div");
          holder.id = mode;
          document.body.appendChild(holder);
          const root = holder.attachShadow({ mode });
          root.innerHTML = "<p></p>";
          return root;
        })();
        roots[mode].querySelector("p").textContent = text;
      };
      const hosted = (mode) => (text) => {
        const half = Math.floor(text.length / 2);
        const line = document.createElement("p");
        const host = document.createElement("span");
        host.attachShadow({ mode }).textContent = text.slice(half);
        line.replaceChildren(text.slice(0, half), host);
        spot.replaceChildren(line);
      };
      const places = {
        hidden: (text) => {
          const half = Math.floor(text.length / 2);
          const line = document.createElement("p");
          const gap = document.createElement("span");
          gap.hidden = true;
          gap.textContent = "ignored";
          line.replaceChildren(text.slice(0, half), gap, text.slice(half));
          spot.replaceChildren(line);
        },
        cvhidden: (text) => {
          const half = Math.floor(text.length / 2);
          const line = document.createElement("p");
          const gap = document.createElement("span");
          gap.style.cssText = "display: inline-block; width: 0; height: 0; content-visibility: hidden";
          gap.textContent = "ignored";
          const host = document.createElement("span");
          host.attachShadow({ mode: "open" }).append(document.createTextNode(text.slice(half)));
          line.replaceChildren(text.slice(0, half), gap, host);
          spot.replaceChildren(line);
        },
        flattened: (text) => {
          const half = Math.floor(text.length / 2);
          const line = document.createElement("p");
          const gap = document.createElement("span");
          gap.style.cssText = "display: inline-block; width: 0; height: 0; transform: rotate(45deg) scaleX(0)";
          gap.textContent = "ignored";
          const host = document.createElement("span");
          host.attachShadow({ mode: "open" }).append(document.createTextNode(text.slice(half)));
          line.replaceChildren(text.slice(0, half), gap, host);
          spot.replaceChildren(line);
        },
        hostsplit: hosted("open"),
        closedsplit: hosted("closed"),
        escaped: (text) => {
          spot.textContent = text.replace(/&/g, "&amp;").replace(/@/g, "&commat;").replace(/[.]/g, "&#x2e;");
        },
        split: (text) => {
          const first = Math.floor(text.length / 3);
          const second = Math.floor((text.length * 2) / 3);
          const strong = document.createElement("strong");
          strong.textContent = text.slice(first, second);
          const line = document.createElement("p");
          line.replaceChildren(text.slice(0, first), strong, text.slice(second));
          spot.replaceChildren(line);
        },
        same: framed(""),
        cross: framed("login.nothing.test"),
        open: rooted("open"),
        closed: rooted("closed"),
        attr: (text) => { spot.innerHTML = '<span id="attr"></span>'; spot.firstChild.setAttribute("data-account", text); },
        after: (text) => {
          const half = Math.floor(text.length / 2);
          spot.innerHTML = '<span id="after"></span>';
          spot.firstChild.textContent = text.slice(0, half);
          spot.firstChild.setAttribute("data-tail", text.slice(half));
        },
        option: (text) => {
          spot.innerHTML = '<select><option value="1"></option></select>';
          spot.querySelector("option").setAttribute("label", text);
        },
        attribute: (text) => { spot.innerHTML = "<span></span>"; spot.firstChild.setAttribute("aria-label", text); },
      };
      const at = new URLSearchParams(location.search).get("at");
      window.ready = Promise.resolve();
      window.put = (text) => (window.ready = Promise.resolve(places[at](text)).then(() => "ready"));
    </script></body>`,
  "/masked": `<!doctype html><title>Masked</title><body>
    <form>
      <input name="u" type="text" autocomplete="username">
      <input name="p" type="password" autocomplete="current-password" oninput="this.value = '*'.repeat(this.value.length)">
    </form></body>`,
  "/tall": `<!doctype html><title>Tall</title><body>
    <form>
      <input name="u" type="text" autocomplete="username" oninput="document.getElementById('who').textContent = this.value">
      <input name="p" type="password" autocomplete="current-password">
    </form>
    <div style="height:1400px"></div>
    <p id="who"></p></body>`,
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
