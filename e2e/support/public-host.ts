import { execFileSync } from "node:child_process";
import { createHmac, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as plainRequest, type IncomingHttpHeaders } from "node:http";
import { createServer, type Server } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { tempDir } from "./run-root.ts";

export const PUBLIC_HOST = "board.example.test";
export const OWNER = "owner@example.test";
export const AUDIENCE = "ab".repeat(32);

const SECOND = 1000;

interface Pair {
  readonly cert: string;
  readonly key: string;
  readonly certFile: string;
}

let pair: Pair | undefined;

function tlsPair(): Pair {
  if (pair !== undefined) return pair;
  const dir = tempDir("fleet-access-tls-");
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2"],
      ...["-subj", "/CN=localhost", "-keyout", keyFile, "-out", certFile],
      ...["-addext", `subjectAltName=DNS:localhost,DNS:${PUBLIC_HOST},IP:127.0.0.1`],
    ],
    { stdio: "ignore" },
  );
  pair = { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8"), certFile };
  return pair;
}

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export function signingKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, publicKey };
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signed(key: SigningKey, claims: Record<string, unknown>): string {
  const head = `${encode({ alg: "RS256", typ: "JWT", kid: key.kid })}.${encode(claims)}`;
  const signature = createSign("RSA-SHA256")
    .update(head)
    .sign(key.privateKey)
    .toString("base64url");
  return `${head}.${signature}`;
}

export function unsigned(key: SigningKey, claims: Record<string, unknown>): string {
  return `${encode({ alg: "none", typ: "JWT", kid: key.kid })}.${encode(claims)}.`;
}

export function critical(name: string, claims: Record<string, unknown>): string {
  return `${encode({ alg: "RS256", typ: "JWT", crit: [name] })}.${encode(claims)}.AAAA`;
}

export function macSigned(key: SigningKey, claims: Record<string, unknown>): string {
  const head = `${encode({ alg: "HS256", typ: "JWT", kid: key.kid })}.${encode(claims)}`;
  const secret = key.publicKey.export({ type: "spki", format: "pem" });
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

function listening(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address: AddressInfo | string | null = server.address();
      if (address === null || typeof address === "string") reject(new Error("no address"));
      else resolve(address.port);
    });
  });
}

function closing(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

export class Issuer {
  hits = 0;
  mode: "serving" | "failing" = "serving";
  published: SigningKey[];
  team = "";
  private readonly server: Server;

  private constructor(published: SigningKey[]) {
    this.published = published;
    const { cert, key } = tlsPair();
    this.server = createServer({ cert, key }, (request, response) => {
      if (request.url !== "/cdn-cgi/access/certs") {
        response.writeHead(404).end();
        return;
      }
      this.hits += 1;
      if (this.mode === "failing") {
        response.writeHead(500).end("certs are down");
        return;
      }
      const keys = this.published.map((each) => ({
        ...each.publicKey.export({ format: "jwk" }),
        kid: each.kid,
        alg: "RS256",
        use: "sig",
      }));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys }));
    });
  }

  static async start(published: SigningKey[]): Promise<Issuer> {
    const issuer = new Issuer(published);
    issuer.team = `127.0.0.1:${String(await listening(issuer.server))}`;
    return issuer;
  }

  get caFile(): string {
    return tlsPair().certFile;
  }

  stop(): Promise<void> {
    return closing(this.server);
  }
}

export class Site {
  readonly key: SigningKey;
  readonly issuer: Issuer;

  private constructor(key: SigningKey, issuer: Issuer) {
    this.key = key;
    this.issuer = issuer;
  }

  static async start(): Promise<Site> {
    const key = signingKey("current");
    return new Site(key, await Issuer.start([key]));
  }

  get flags(): string[] {
    return [
      ...["--public-host", PUBLIC_HOST, "--access-team", this.issuer.team],
      ...["--access-aud", AUDIENCE, "--access-email", OWNER],
    ];
  }

  get env(): { NODE_EXTRA_CA_CERTS: string } {
    return { NODE_EXTRA_CA_CERTS: this.issuer.caFile };
  }

  claims(changes: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / SECOND);
    return {
      aud: [AUDIENCE],
      email: OWNER,
      exp: now + 300,
      iat: now - 10,
      nbf: now - 10,
      iss: `https://${this.issuer.team}`,
      type: "app",
      ...changes,
    };
  }

  token(changes: Record<string, unknown> = {}): string {
    return signed(this.key, this.claims(changes));
  }
}

function wireHeaders(headers: IncomingHttpHeaders): string[] {
  return Object.entries(headers).flatMap(([name, value]) =>
    typeof value === "string" ? [`${name}: ${value}`] : [],
  );
}

export class Edge {
  token: string | undefined;
  rewriteHost: string | undefined;
  port = 0;
  private readonly server: Server;

  private constructor(target: URL) {
    const { cert, key } = tlsPair();
    this.server = createServer({ cert, key }, (request, response) => {
      const upstream = plainRequest(
        {
          host: target.hostname,
          port: target.port,
          method: request.method,
          path: request.url,
          headers: this.headersFor(request.headers),
        },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.destroy();
      });
      request.pipe(upstream);
    });
    this.server.on("upgrade", (request, socket, head) => {
      const upstream = connect(Number(target.port), target.hostname, () => {
        upstream.write(`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1\r\n`);
        upstream.write(`${wireHeaders(this.headersFor(request.headers)).join("\r\n")}\r\n\r\n`);
        upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      for (const each of [socket, upstream]) {
        each.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
        each.on("close", () => {
          socket.destroy();
          upstream.destroy();
        });
      }
    });
  }

  static async start(target: URL): Promise<Edge> {
    const edge = new Edge(target);
    edge.port = await listening(edge.server);
    return edge;
  }

  private headersFor(incoming: IncomingHttpHeaders): IncomingHttpHeaders {
    const headers: IncomingHttpHeaders = {
      ...incoming,
      "cf-connecting-ip": "203.0.113.7",
      "cf-ray": "8a1b2c3d4e5f-AMS",
      "cdn-loop": "cloudflare; loops=1",
      "x-forwarded-for": "203.0.113.7",
    };
    delete headers["cf-access-jwt-assertion"];
    if (this.rewriteHost !== undefined) headers.host = this.rewriteHost;
    if (this.token !== undefined) headers["cf-access-jwt-assertion"] = this.token;
    return headers;
  }

  stop(): Promise<void> {
    return closing(this.server);
  }
}

export function exchange(
  base: URL,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = plainRequest(new URL(path, base), { method, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body: text });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export function upgrade(
  base: URL,
  path: string,
  headers: Record<string, string>,
): Promise<"opened" | "refused"> {
  return new Promise((resolve) => {
    const req = plainRequest(new URL(path, base), {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("upgrade", (_response, socket) => {
      socket.destroy();
      resolve("opened");
    });
    req.on("error", () => {
      resolve("refused");
    });
    req.end();
  });
}
