import { EventEmitter } from "node:events";
import { type LaneName, parseLaneName } from "../shared/lane-name.js";
import type { Handoff, LaneSnapshot } from "../shared/protocol.js";
import { Captcha } from "./captcha.js";
import type { Config } from "./config.js";
import { Credentials } from "./credentials.js";
import { Lane } from "./lane.js";
import { Notifier } from "./notify.js";
import { SlotRegistry } from "./registry.js";
import { TokenStore } from "./tokens.js";

export class Daemon extends EventEmitter {
  readonly config: Config;
  readonly tokens: TokenStore;
  readonly credentials: Credentials;
  readonly captcha: Captcha;
  private readonly notifier: Notifier;
  private readonly registry: SlotRegistry;
  private readonly lanes = new Map<string, Lane>();

  constructor(config: Config) {
    super();
    this.config = config;
    this.tokens = new TokenStore(config.stream.tokenDir);
    this.credentials = new Credentials(config);
    this.captcha = new Captcha(config);
    this.notifier = new Notifier(config);
    this.registry = new SlotRegistry(config);
    for (const name of this.registry.names()) this.lane(parseLaneName(name));
  }

  lane(name: LaneName): Lane {
    let lane = this.lanes.get(name);
    if (!lane) {
      const created = new Lane(name, this.registry.slotFor(name), this.config);
      lane = created;
      created.on("change", () => void this.relayLane(created));
      created.on("handoff", (handoff: Handoff) => {
        this.emit("handoff", { lane: name, handoff });
        void created
          .snapshot()
          .then((snapshot) => this.notifier.handoffOpened(name, handoff, snapshot.viewLink))
          .catch((error: Error) => console.error(`phone notification failed: ${error.message}`));
      });
      this.lanes.set(name, lane);
    }
    return lane;
  }

  all(): Lane[] {
    return [...this.lanes.values()];
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.all().map((lane) => lane.stop()));
  }

  private async relayLane(lane: Lane): Promise<void> {
    const snapshot: LaneSnapshot = await lane.snapshot();
    this.emit("lane", snapshot);
  }
}
