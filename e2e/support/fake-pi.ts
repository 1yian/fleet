import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [command, source] = process.argv.slice(2);
const state = process.env["FAKE_PI_STATE"] ?? "";
const log = process.env["FAKE_PI_LOG"];
if (log !== undefined) appendFileSync(log, `${process.argv.slice(2).join(" ")}\n`);
if (command === "list") {
  console.log("User packages:");
  const lines = existsSync(state) ? readFileSync(state, "utf8").split("\n") : [];
  for (const line of lines) if (line !== "") console.log(`  ${line}`);
} else if (command === "install") {
  appendFileSync(state, `${source ?? ""}\n`);
  console.log(`Installed ${source ?? ""}`);
} else if (command === "update") {
  if (source === undefined && process.env["FAKE_PI_SELF_UPDATE_REFUSAL"] !== undefined) {
    console.error(process.env["FAKE_PI_SELF_UPDATE_REFUSAL"]);
    process.exit(1);
  }
  console.log(source === undefined ? "pi is up to date" : `Updated ${source}`);
} else {
  console.error(`fake pi: unexpected invocation: ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}
