import { loadConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { createAgentServer, createStreamServer } from "./http.js";

const config = loadConfig();
const daemon = new Daemon(config);
const agent = createAgentServer(daemon);
const stream = createStreamServer(daemon);

agent.listen(config.agent.port, config.agent.host, () => {
  process.stdout.write(`agent api on ${config.agent.host}:${config.agent.port}\n`);
});
stream.listen(config.stream.port, config.stream.host, () => {
  process.stdout.write(`stream api on ${config.stream.host}:${config.stream.port}\n`);
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${signal}: stopping lanes\n`);
  agent.close();
  stream.close();
  await daemon.stopAll();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
