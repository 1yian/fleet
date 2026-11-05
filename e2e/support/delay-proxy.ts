import { createConnection, createServer, type Server, type Socket } from "node:net";

function delayed(from: Socket, to: Socket, delayMs: number): void {
  from.on("data", (chunk: Buffer) => {
    setTimeout(() => {
      if (!to.destroyed) to.write(chunk);
    }, delayMs);
  });
  from.on("end", () => {
    setTimeout(() => {
      to.end();
    }, delayMs);
  });
  from.on("error", () => to.destroy());
}

export class DelayProxy {
  port = 0;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  private constructor(target: number, oneWayMs: number) {
    this.server = createServer((client) => {
      const upstream = createConnection({ port: target, host: "127.0.0.1" });
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
      }
      delayed(client, upstream, oneWayMs);
      delayed(upstream, client, oneWayMs);
    });
  }

  static async start(target: number, oneWayMs: number): Promise<DelayProxy> {
    const proxy = new DelayProxy(target, oneWayMs);
    await new Promise<void>((resolve) => proxy.server.listen(0, "127.0.0.1", resolve));
    const address = proxy.server.address();
    if (address === null || typeof address === "string") throw new Error("the proxy has no port");
    proxy.port = address.port;
    return proxy;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
