import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrokerConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import { OpCli } from "./opcli.js";
import { importLogin } from "./vaults.js";

async function main(): Promise<void> {
  const [lane, title, username, url] = process.argv.slice(2);
  if (!lane || !title || !username || !url) {
    throw new BrokerError(
      "BAD_REQUEST",
      "usage: import <lane> <title> <username> <https-url>   (password on stdin)",
    );
  }
  const password = readFileSync(0, "utf8").replace(/[\r\n]+$/, "");
  const config = loadBrokerConfig();
  const token = readFileSync(config.tokenFile, "utf8").trim();
  const home = mkdtempSync(join(tmpdir(), "fleet-browser-import-"));
  try {
    const vault = await importLogin(
      new OpCli(config.opPath, token, home),
      config,
      lane,
      { title, username, url, password },
      (line) => process.stderr.write(`${line}\n`),
    );
    process.stdout.write(`imported "${title}" into vault ${vault}\n`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `import failed: ${error instanceof BrokerError ? error.message : "unexpected error"}\n`,
  );
  process.exit(1);
});
