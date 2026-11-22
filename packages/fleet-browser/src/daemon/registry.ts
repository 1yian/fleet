import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LaneName } from "../shared/lane-name.js";
import type { Config } from "./config.js";

export interface LaneSlot {
  slot: number;
  display: number;
  cdpPort: number;
  cpuList: string;
}

export class SlotRegistry {
  private readonly path: string;
  private readonly slots: Record<string, number>;
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
    this.path = join(config.dataDir, "lanes.json");
    this.slots = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, "utf8")) as Record<string, number>)
      : {};
  }

  forget(lane: string): void {
    delete this.slots[lane];
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.slots, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }

  names(): string[] {
    return Object.keys(this.slots);
  }

  slotFor(lane: LaneName): LaneSlot {
    let slot = this.slots[lane];
    if (slot === undefined) {
      const used = new Set(Object.values(this.slots));
      slot = 0;
      while (used.has(slot)) slot += 1;
      if (slot >= this.config.lanes.max) throw new Error(`lane limit of ${this.config.lanes.max} reached`);
      this.slots[lane] = slot;
      this.save();
    }
    const { cpusPerLane, totalCpus, firstDisplay, firstCdpPort } = this.config.lanes;
    const start = (slot * cpusPerLane) % totalCpus;
    return {
      slot,
      display: firstDisplay + slot,
      cdpPort: firstCdpPort + slot,
      cpuList: `${start}-${Math.min(start + cpusPerLane, totalCpus) - 1}`,
    };
  }
}
