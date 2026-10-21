const LIVE_FLEET = [
  "FLEET_HOSTS",
  "FLEET_HOST",
  "FLEET_ROOTS",
  "FLEET_ROOT",
  "FLEET_URL",
  "FLEET_TOKEN",
  "FLEET_ROLE",
  "FLEET_PI_ARGS",
  "FLEET_CONFIG_DIR",
];

for (const name of LIVE_FLEET) Reflect.deleteProperty(process.env, name);
