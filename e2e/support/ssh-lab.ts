import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { tempDir } from "./run-root.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no SSH lab port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  return address.port;
}

export class SshLab {
  readonly bin = tempDir("fleet-real-ssh-");
  private child: ChildProcess | undefined;
  private log = "";

  async start(): Promise<void> {
    const hostKey = join(this.bin, "host");
    const clientKey = join(this.bin, "client");
    for (const key of [hostKey, clientKey])
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const port = await freePort();
    const known = join(this.bin, "known_hosts");
    writeFileSync(known, `[127.0.0.1]:${String(port)} ${readFileSync(`${hostKey}.pub`, "utf8")}`);
    const config = join(this.bin, "sshd_config");
    writeFileSync(
      config,
      [
        `Port ${String(port)}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `PidFile ${join(this.bin, "sshd.pid")}`,
        `AuthorizedKeysFile ${clientKey}.pub`,
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "PermitRootLogin yes",
        "LogLevel VERBOSE",
        "",
      ].join("\n"),
    );
    const clientConfig = join(this.bin, "ssh_config");
    writeFileSync(
      clientConfig,
      [
        "Host fleet-click-lab",
        "  HostName 127.0.0.1",
        `  Port ${String(port)}`,
        `  User ${userInfo().username}`,
        `  IdentityFile ${clientKey}`,
        `  UserKnownHostsFile ${known}`,
        "  StrictHostKeyChecking yes",
        "  IdentitiesOnly yes",
        "  BatchMode yes",
        "  ControlMaster no",
        "",
      ].join("\n"),
    );
    const shim = join(this.bin, "ssh");
    writeFileSync(shim, `#!/bin/sh\nexec /usr/bin/ssh -F '${clientConfig}' "$@"\n`);
    chmodSync(shim, 0o755);
    this.child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child.stderr?.on("data", (data: Buffer) => (this.log += data.toString()));
    const deadline = Date.now() + 10_000;
    while (!this.log.includes("Server listening")) {
      if (this.child.exitCode !== null || Date.now() > deadline)
        throw new Error(`SSH lab did not listen: ${this.log}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  evidence(): string {
    return this.log;
  }

  async stop(): Promise<void> {
    if (this.child?.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGTERM");
    await exited;
  }
}
