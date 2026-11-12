import { createServer, type Server, type ServerResponse } from "node:http";

const LOGIN = `<title>login</title><style>body{margin:0}input{display:block;width:240px;height:30px;margin:0}</style>
<form id="f" method="post" action="/submit"><input id="user" name="user" autocomplete="off"><input id="pw" name="pw" type="password" autocomplete="off"><button id="go">Sign in</button></form>`;

const AUTOFOCUS = LOGIN.replace(
  'autocomplete="off"><button',
  'autocomplete="off" autofocus><button',
).replace("<title>login</title>", "<title>autofocus</title>");

const spa = (
  endpoint: string,
): string => `<title>spa</title><style>body{margin:0}input,button{display:block;width:240px;height:30px;margin:0}</style>
<input id="user" autocomplete="off"><input id="pw" type="password" autocomplete="off"><button id="go" type="button">Sign in</button>
<script>
document.querySelector("#go").addEventListener("click", () => {
  const field = document.querySelector("#pw");
  fetch("${endpoint}", { method: "POST", headers: { "content-type": "text/plain" }, body: "pw=" + field.value });
  field.value = "";
});
</script>`;

const NOTES = `<title>notes</title><p id="note">plain notes</p>`;

const FIELD_STYLE = `body{margin:0}input{display:block;box-sizing:border-box;width:240px;height:30px;margin:0}x-login,x-filled,x-sealed,x-built,x-held,x-nested{display:block;width:240px;height:30px}`;

const CLOSED = `<title>closed</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off"><x-login id="login"></x-login>
<script>
let field;
customElements.define("x-login", class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>${FIELD_STYLE}</style><input type="password" autocomplete="off">';
    field = root.querySelector("input");
  }
});
window.fieldValue = () => field.value;
</script>`;

const SEALED_ELEMENT = (
  tag: string,
): string => `customElements.define("${tag}", class extends HTMLElement {
  constructor() {
    super();
    this.internals = this.attachInternals();
  }
  peek() {
    return this.internals.shadowRoot.querySelector("input").value;
  }
});`;

const SEALED_MARKUP = (tag: string): string =>
  `<${tag} id="${tag}"><template shadowrootmode="closed"><style>${FIELD_STYLE}</style><input type="password" autocomplete="off"></template></${tag}>`;

const SEALED = `<title>sealed</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off">${SEALED_MARKUP("x-sealed")}
<script>${SEALED_ELEMENT("x-sealed")}</script>`;

const BUILT = `<title>built</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off"><div id="slot"></div>
<script>
${SEALED_ELEMENT("x-built")}
window.build = () => document.querySelector("#slot").setHTMLUnsafe(${JSON.stringify(SEALED_MARKUP("x-built"))});
</script>`;

const HELD = `<title>held</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off">
`;

const HELD_ROOT = `${SEALED_MARKUP("x-held")}
`;

const NESTED = `<title>nested</title><style>${FIELD_STYLE}</style>
<input id="user" autocomplete="off"><x-nested id="x-nested"><template shadowrootmode="closed"><style>${FIELD_STYLE}</style><div id="inner"><template shadowrootmode="open"><style>${FIELD_STYLE}</style><input type="password" autocomplete="off"></template></div></template></x-nested>
<script>
customElements.define("x-nested", class extends HTMLElement {
  constructor() {
    super();
    this.internals = this.attachInternals();
  }
  peek() {
    return this.internals.shadowRoot.querySelector("#inner").shadowRoot.querySelector("input").value;
  }
});
</script>`;

const DECLARED = `<title>declared</title><style>${FIELD_STYLE}</style>
<div><template shadowrootmode="open"><input type="password" value="declared-secret"></template></div>`;

const FILLED = `<title>filled</title><style>${FIELD_STYLE}</style>
<x-filled></x-filled>
<script>
customElements.define("x-filled", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = '<input type="password" value="seeded-secret">';
  }
});
</script>`;

const FRAME = `<style>body{margin:0}input{display:block;width:240px;height:30px;margin:0}</style><input id="pw" type="password" autocomplete="off">`;

const pagesFor = (port: number): ReadonlyMap<string, string> =>
  new Map([
    ["/login", LOGIN],
    ["/spa", spa("/api/login")],
    ["/echo", spa("/api/echo")],
    ["/holdecho", spa("/api/hold")],
    ["/autofocus", AUTOFOCUS],
    ["/closed", CLOSED],
    ["/filled", FILLED],
    ["/declared", DECLARED],
    ["/sealed", SEALED],
    ["/built", BUILT],
    ["/nested", NESTED],
    [
      "/embed",
      `<title>embed</title><style>body{margin:0}iframe{display:block;border:0;width:300px;height:100px}</style><iframe id="inner" src="http://two.test:${String(port)}/frame"></iframe>`,
    ],
    ["/frame", FRAME],
  ]);

const readBody = (request: NodeJS.ReadableStream): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

export class Site {
  readonly submitted: string[];
  readonly port: number;
  private readonly server: Server;
  private readonly held: ServerResponse[];
  private readonly logins: ServerResponse[];
  private readonly echoes: { response: ServerResponse; body: string }[];

  private constructor(
    server: Server,
    port: number,
    submitted: string[],
    held: ServerResponse[],
    logins: ServerResponse[],
    echoes: { response: ServerResponse; body: string }[],
  ) {
    this.server = server;
    this.port = port;
    this.submitted = submitted;
    this.held = held;
    this.logins = logins;
    this.echoes = echoes;
  }

  static async start(): Promise<Site> {
    const submitted: string[] = [];
    const held: ServerResponse[] = [];
    const logins: ServerResponse[] = [];
    const echoes: { response: ServerResponse; body: string }[] = [];
    let port = 0;
    const posts = new Map<string, (body: string, response: ServerResponse) => void>([
      [
        "/submit",
        (body, response) => {
          submitted.push(body);
          response.end("<title>welcome</title>welcome");
        },
      ],
      ["/api/login", (_body, response) => logins.push(response)],
      ["/api/echo", (body, response) => response.end(`you sent ${body}`)],
      ["/api/hold", (body, response) => echoes.push({ response, body })],
      [
        "/api/done",
        (body, response) => {
          submitted.push(body);
          response.end("ok");
        },
      ],
    ]);
    const server = createServer((request, response) => {
      const path = request.url ?? "/";
      response.setHeader("content-type", "text/html");
      const post = request.method === "POST" ? posts.get(path) : undefined;
      if (post !== undefined) {
        void readBody(request).then((body) => {
          post(body, response);
        });
      } else if (path === "/held") {
        response.write(HELD);
        held.push(response);
      } else response.end(pagesFor(port).get(path) ?? NOTES);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
    return new Site(server, port, submitted, held, logins, echoes);
  }

  url(path: string, host = "one.test"): string {
    return `http://${host}:${String(this.port)}${path}`;
  }

  continueHeld(): void {
    for (const response of this.held) response.write(HELD_ROOT);
  }

  heldLogins(): number {
    return this.logins.length;
  }

  heldEchoes(): number {
    return this.echoes.length;
  }

  answerEchoes(): void {
    for (const { response, body } of this.echoes.splice(0)) response.end(`you sent ${body}`);
  }

  redirectLogins(): void {
    for (const response of this.logins.splice(0))
      response.writeHead(307, { location: "/api/done" }).end();
  }

  release(): void {
    for (const response of this.held.splice(0)) response.end("<p>done</p>");
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
