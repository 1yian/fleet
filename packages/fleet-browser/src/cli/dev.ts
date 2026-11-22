import { AxiError } from "axi-sdk-js";
import { cleanOutput, mergedConsole, PASS_THROUGH, runAgentBrowser, runDevBrowser } from "./browser.js";
import { daemon } from "./client.js";
import { renderStatus } from "./status.js";

function take(rest: string[], flag: string): string | undefined {
  const at = rest.indexOf(flag);
  if (at === -1) return undefined;
  const value = rest[at + 1];
  rest.splice(at, 2);
  return value;
}

export async function devCommand(args: string[]) {
  const rest = [...args];
  const name = take(rest, "--name") ?? "main";
  if (!/^[a-z0-9][a-z0-9-]{0,24}$/.test(name)) {
    throw new AxiError("name must be lowercase letters, digits and hyphens", "BAD_DEV_NAME", [
      "Run `fleet-browser dev --name checkout open http://localhost:3000`",
    ]);
  }
  const headful = rest.includes("--headful");
  if (headful) rest.splice(rest.indexOf("--headful"), 1);
  const verb = rest.shift();
  if (headful) return headfulDev(`dev-${name}`, verb, rest);
  if (!verb) {
    throw new AxiError("a browser verb is required", "NO_VERB", [
      "Run `fleet-browser dev open http://localhost:3000`, then `fleet-browser dev snapshot -i`",
    ]);
  }
  if (verb === "close") {
    await runDevBrowser(name, ["close"]);
    return "dev browser closed; its profile is gone";
  }
  if (verb === "console") return mergedConsole((a) => runDevBrowser(name, a), rest);
  if (!PASS_THROUGH.has(verb)) {
    throw new AxiError(`unknown browser verb ${verb}`, "UNKNOWN_VERB", ["Run `fleet-browser --help`"]);
  }
  const result = await runDevBrowser(name, [verb, ...rest]);
  const text = cleanOutput(result.stdout + result.stderr).trimEnd();
  if (result.code !== 0)
    throw new AxiError(text || `agent-browser exited with ${result.code}`, "BROWSER_COMMAND_FAILED");
  return text;
}

async function headfulDev(lane: string, verb: string | undefined, rest: string[]) {
  if (!verb) return renderStatus(await daemon.start(lane));
  if (verb === "close") {
    await daemon.stop(lane);
    return "dev lane closed; its profile is gone";
  }
  const snapshot = await daemon.start(lane);
  if (verb === "console") return mergedConsole((a) => runAgentBrowser(lane, a), rest);
  if (!PASS_THROUGH.has(verb)) {
    throw new AxiError(`unknown browser verb ${verb}`, "UNKNOWN_VERB", ["Run `fleet-browser --help`"]);
  }
  const result = await runAgentBrowser(lane, [verb, ...rest]);
  const text = cleanOutput(result.stdout + result.stderr).trimEnd();
  if (result.code !== 0)
    throw new AxiError(text || `agent-browser exited with ${result.code}`, "BROWSER_COMMAND_FAILED");
  return snapshot.viewLink && verb === "open"
    ? `${text}\nwatch: ${snapshot.viewLink.replace("{lane}", lane)}`
    : text;
}
