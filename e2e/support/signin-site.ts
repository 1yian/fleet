import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const ACCOUNT = {
  identifier: "captain@example.test",
  password: "tide-and-anchor-7",
  code: "246810",
} as const;

const STYLE = `<style>
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif; background: #f0f4f9; }
  main { box-sizing: border-box; width: min(450px, 100%); margin: 24px auto; padding: 36px 40px; background: #fff; border-radius: 28px; }
  h1 { margin: 0 0 8px; font-size: 24px; font-weight: 400; }
  p { margin: 0 0 24px; color: #444; }
  input[type=text], input[type=email], input[type=password] { box-sizing: border-box; width: 100%; height: 56px; padding: 0 14px; font-size: 16px; border: 1px solid #747775; border-radius: 4px; }
  button { height: 40px; padding: 0 24px; margin-top: 32px; font-size: 14px; color: #fff; background: #0b57d0; border: 0; border-radius: 20px; }
  .error { margin: 8px 0 0; color: #b3261e; }
</style>`;

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${STYLE}</head><body><main>${body}</main></body></html>`;

const identifierPage = (): string =>
  page(
    "Sign in",
    `<h1>Sign in</h1><p>to continue to My Account</p>
    <form method="post" action="/signin/identifier">
      <input id="identifier" name="identifier" type="email" autocomplete="username" autocapitalize="none" autofocus aria-label="Email or phone">
      <button id="next" type="submit">Next</button>
    </form>`,
  );

const passwordPage = (identifier: string, error: boolean): string =>
  page(
    "Welcome",
    `<h1>Welcome</h1><p id="who">${identifier}</p>
    <form method="post" action="/signin/password">
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus aria-label="Enter your password">
      ${error ? '<div class="error" id="error">Wrong password. Try again.</div>' : ""}
      <button id="next" type="submit">Next</button>
    </form>`,
  );

const codePage = (error: boolean): string =>
  page(
    "2-Step Verification",
    `<h1>2-Step Verification</h1><p>Enter the 6-digit code from your phone</p>
    <form method="post" action="/signin/challenge">
      <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" autofocus aria-label="Enter code">
      ${error ? '<div class="error" id="error">Wrong code. Try again.</div>' : ""}
      <button id="next" type="submit">Next</button>
    </form>`,
  );

const termsPage = (): string =>
  page(
    "Terms",
    `<h1>Terms of service</h1>
    ${"<p>You agree to keep the fleet running. </p>".repeat(60)}
    <form method="post" action="/terms"><button id="agree" type="submit">I agree</button></form>`,
  );

const welcomePage = (identifier: string): string =>
  page("My Account", `<h1 id="welcome">Signed in as ${identifier}</h1><p>You are done.</p>`);

function bodyOf(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => {
      resolve(new URLSearchParams(body));
    });
    request.on("error", reject);
  });
}

const html = (response: ServerResponse, body: string): void => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
};

const redirect = (response: ServerResponse, to: string): void => {
  response.writeHead(303, { location: to }).end();
};

export class SignInSite {
  readonly pages: string[] = [];
  readonly port: number;
  private readonly server: Server;
  private readonly landingHost: string;
  private identifier = "";

  private constructor(server: Server, port: number, landingHost: string) {
    this.server = server;
    this.port = port;
    this.landingHost = landingHost;
  }

  static async start(landingHost: string): Promise<SignInSite> {
    const holder: { site: SignInSite | undefined } = { site: undefined };
    const server = createServer((request, response) => {
      void holder.site?.answer(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") throw new Error("no site address");
    holder.site = new SignInSite(server, address.port, landingHost);
    return holder.site;
  }

  get signedIn(): boolean {
    return this.pages.at(-1) === "/welcome";
  }

  url(path: string, host: string): string {
    return `http://${host}:${String(this.port)}${path}`;
  }

  private async post(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const form = await bodyOf(request);
    if (path === "/signin/identifier") {
      this.identifier = form.get("identifier") ?? "";
      redirect(response, "/signin/password");
    } else if (path === "/signin/password") {
      const right =
        this.identifier === ACCOUNT.identifier && form.get("password") === ACCOUNT.password;
      if (right) redirect(response, "/signin/challenge");
      else html(response, passwordPage(this.identifier, true));
    } else if (path === "/signin/challenge") {
      if (form.get("code") === ACCOUNT.code)
        redirect(response, this.url("/welcome", this.landingHost));
      else html(response, codePage(true));
    } else if (path === "/terms") redirect(response, this.url("/welcome", this.landingHost));
    else response.writeHead(404).end();
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://site").pathname;
    if (request.method === "POST") {
      await this.post(path, request, response);
      return;
    }
    const pages: Record<string, () => string> = {
      "/signin": identifierPage,
      "/signin/password": () => passwordPage(this.identifier, false),
      "/signin/challenge": () => codePage(false),
      "/terms": termsPage,
      "/welcome": () => welcomePage(this.identifier),
    };
    const render = pages[path];
    if (render === undefined) response.writeHead(404).end();
    else {
      this.pages.push(path);
      html(response, render());
    }
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
