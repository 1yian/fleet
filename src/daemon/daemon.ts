import { EventEmitter } from "node:events";
import { type LaneName, parseLaneName } from "../shared/lane-name.js";
import type { Handoff, LaneSnapshot } from "../shared/protocol.js";
import type { Config } from "./config.js";
import { Lane } from "./lane.js";
import { SlotRegistry } from "./registry.js";
import { TokenStore } from "./tokens.js";

export class Daemon extends EventEmitter {
  readonly config: Config;
  readonly tokens: TokenStore;
  private readonly registry: SlotRegistry;
  private readonly lanes = new Map<string, Lane>();

  constructor(config: Config) {
    super();
    this.config = config;
    this.tokens = new TokenStore(config.stream.tokenDir);
    this.registry = new SlotRegistry(config);
    for (const name of this.registry.names()) this.lane(parseLaneName(name));
  }

  lane(name: LaneName): Lane {
    let lane = this.lanes.get(name);
    if (!lane) {
      lane = new Lane(name, this.registry.slotFor(name), this.config);
      lane.on("change", () => void this.relayLane(lane as Lane));
      lane.on("handoff", (handoff: Handoff) => this.emit("handoff", { lane: name, handoff }));
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
