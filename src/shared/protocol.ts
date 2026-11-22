import type { LaneName } from "./lane-name.js";

export type LaneStatusName = "stopped" | "starting" | "ready" | "failed";

export type Control = { kind: "agent" } | { kind: "human"; viewerId: string; since: number };

export type HandoffStatus = "open" | "done" | "cancelled" | "expired";

export interface Handoff {
  id: string;
  lane: LaneName;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: HandoffStatus;
  resolvedAt?: number;
}

export interface TabInfo {
  id: string;
  title: string;
  url: string;
}

export type AgentStep = "credentials" | "direct-login" | "captcha";

export interface LaneSnapshot {
  lane: LaneName;
  status: LaneStatusName;
  error: string | null;
  chromeVersion?: string;
  chromePid?: number;
  display: string;
  tabs: TabInfo[];
  control: Control;
  handoff: Handoff | null;
  credentialStep: boolean;
  captchaStep: boolean;
  viewLink: string | null;
}

export interface FrameMeta {
  deviceWidth: number;
  deviceHeight: number;
  offsetTop: number;
  pageScaleFactor: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp?: number;
  targetId: string;
}

export type StreamInput =
  | {
      t: "mouse";
      type: "mouseMoved" | "mousePressed" | "mouseReleased";
      x: number;
      y: number;
      button: "none" | "left" | "middle" | "right";
      buttons: number;
      clickCount: number;
      modifiers: number;
    }
  | { t: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
      t: "key";
      type: "keyDown" | "keyUp" | "rawKeyDown";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      modifiers: number;
      commands?: string[];
    }
  | { t: "text"; text: string };

export type StreamCommand =
  | { t: "control"; on: boolean; force?: boolean }
  | { t: "viewport"; width: number; height: number; deviceScaleFactor?: number; mobile?: boolean }
  | { t: "viewport"; reset: true }
  | { t: "navigate"; url: string }
  | { t: "history"; direction: "back" | "forward" }
  | { t: "reload" }
  | { t: "tab"; action: "activate" | "close" | "new"; id?: string }
  | { t: "done" };
