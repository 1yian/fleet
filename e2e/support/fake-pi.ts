import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [command, source] = process.argv.slice(2);
const state = process.env["FAKE_PI_STATE"] ?? "";
if (command === "list") {
  console.log("User packages:");
  const lines = existsSync(state) ? readFileSync(state, "utf8").split("\n") : [];
  for (const line of lines) if (line !== "") console.log(`  ${line}`);
} else if (command === "install") {
  appendFileSync(state, `${source ?? ""}\n`);
  console.log(`Installed ${source ?? ""}`);
} else {
  console.error(`fake pi: unexpected invocation: ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}
