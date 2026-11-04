import "./run-root.ts";

const LIVE_ENVIRONMENT = [
  "FLEET_HOSTS",
  "FLEET_HOST",
  "FLEET_ROOTS",
  "FLEET_ROOT",
  "FLEET_URL",
  "FLEET_TOKEN",
  "FLEET_BWS",
  "FLEET_ROLE",
  "FLEET_PI_ARGS",
  "FLEET_CONFIG_DIR",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SESSION",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
];

for (const name of LIVE_ENVIRONMENT) Reflect.deleteProperty(process.env, name);
