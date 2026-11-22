import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { BrowserFrame } from "@fleet/protocol";
import type { BrowserInput } from "./browser-session.ts";

function modifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    Number(event.altKey) |
    (Number(event.ctrlKey) << 1) |
    (Number(event.metaKey) << 2) |
    (Number(event.shiftKey) << 3)
  );
}

function position(
  frame: BrowserFrame,
  event: { clientX: number; clientY: number },
  surface: HTMLElement,
) {
  const rect =
    surface.firstElementChild?.getBoundingClientRect() ?? surface.getBoundingClientRect();
  const fraction = (value: number): number => Math.max(0, Math.min(0.9999, value));
  return {
    x: fraction((event.clientX - rect.left) / rect.width) * frame.meta.deviceWidth,
    y: fraction((event.clientY - rect.top) / rect.height) * frame.meta.deviceHeight,
  };
}

interface Props {
  readonly frame: BrowserFrame;
  readonly driving: boolean;
  readonly input: (target: string, event: BrowserInput) => void;
}

type MouseInput = Extract<BrowserInput, { t: "mouse" }>;

const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 5;

function mouseInput(
  event: PointerEvent<HTMLDivElement>,
  frame: BrowserFrame,
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  count: number,
): MouseInput {
  return {
    t: "mouse",
    type,
    ...position(frame, event, event.currentTarget),
    button: ["left", "middle", "right"][event.button] ?? "none",
    buttons: event.buttons,
    clickCount: type === "mouseMoved" ? 0 : count,
    modifiers: modifiers(event),
  };
}

function keyInput(event: KeyboardEvent<HTMLDivElement>, down: boolean): BrowserInput {
  const printable =
    Array.from(event.key).length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  return {
    t: "key",
    type: down ? (printable ? "keyDown" : "rawKeyDown") : "keyUp",
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    ...(down && printable ? { text: event.key } : {}),
    modifiers: modifiers(event),
  };
}

class Gestures {
  private last = Gestures.idle();
  private readonly pressed = new Map<number, MouseInput>();
  private readonly held = new Map<string, BrowserInput>();

  private static idle() {
    return { count: 0, at: 0, x: 0, y: 0, button: -1 };
  }

  reset(): void {
    this.last = Gestures.idle();
    this.pressed.clear();
    this.held.clear();
  }

  press(event: PointerEvent<HTMLDivElement>, frame: BrowserFrame): MouseInput {
    const { last } = this;
    const repeated =
      event.button === last.button &&
      event.timeStamp - last.at < MULTI_CLICK_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) <= MULTI_CLICK_PX;
    const press = mouseInput(event, frame, "mousePressed", repeated ? last.count + 1 : 1);
    this.pressed.set(event.button, press);
    return press;
  }

  release(event: PointerEvent<HTMLDivElement>, frame: BrowserFrame): MouseInput | undefined {
    const press = this.pressed.get(event.button);
    if (press === undefined) return undefined;
    this.pressed.delete(event.button);
    this.last = {
      count: press.clickCount,
      at: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
      button: event.button,
    };
    return mouseInput(event, frame, "mouseReleased", press.clickCount);
  }

  releasePointer(): MouseInput[] {
    const releases = [...this.pressed.values()].map((press): MouseInput => ({
      ...press,
      type: "mouseReleased",
      buttons: 0,
    }));
    this.pressed.clear();
    if (releases.length > 0) this.last = Gestures.idle();
    return releases;
  }

  key(event: KeyboardEvent<HTMLDivElement>, down: boolean): BrowserInput {
    if (down) this.held.set(event.code, keyInput(event, false));
    else this.held.delete(event.code);
    return keyInput(event, down);
  }

  releaseKeys(): BrowserInput[] {
    const releases = [...this.held.values()].map((release): BrowserInput => ({
      ...release,
      modifiers: 0,
    }));
    this.held.clear();
    return releases;
  }
}

export function BrowserSurface({ frame, driving, input }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const target = frame.meta.targetId;
  const gestures = useMemo(() => new Gestures(), []);
  useEffect(
    () => () => {
      gestures.reset();
    },
    [gestures, driving, target],
  );
  const releasePointer = (): void => {
    for (const release of gestures.releasePointer()) input(target, release);
  };
  useEffect(() => {
    const element = surface.current;
    if (!driving || element === null) return;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const scale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.meta.deviceHeight : 1;
      input(target, {
        t: "wheel",
        ...position(frame, event, element),
        deltaX: event.deltaX * scale,
        deltaY: event.deltaY * scale,
        modifiers: modifiers(event),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
    };
  }, [driving, frame, input, target]);
  const keyboard =
    (down: boolean) =>
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (!driving) return;
      if (event.shiftKey && event.key === "Escape") {
        event.currentTarget.blur();
        return;
      }
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      input(target, gestures.key(event, down));
    };
  return (
    <div
      ref={surface}
      className={driving ? "browser-surface driving" : "browser-surface"}
      role={driving ? "application" : undefined}
      aria-label={driving ? "Browser controls" : undefined}
      tabIndex={driving ? 0 : undefined}
      onPointerDown={(event) => {
        if (!driving) return;
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        input(target, gestures.press(event, frame));
      }}
      onPointerMove={(event) => {
        if (driving) input(target, mouseInput(event, frame, "mouseMoved", 0));
      }}
      onPointerUp={(event) => {
        const release = driving ? gestures.release(event, frame) : undefined;
        if (release !== undefined) input(target, release);
      }}
      onPointerCancel={() => {
        releasePointer();
      }}
      onLostPointerCapture={() => {
        releasePointer();
      }}
      onBlur={() => {
        if (!driving) return;
        for (const release of gestures.releaseKeys()) input(target, release);
      }}
      onContextMenu={(event) => {
        if (driving) event.preventDefault();
      }}
      onKeyDown={keyboard(true)}
      onKeyUp={keyboard(false)}
    >
      <img
        draggable={false}
        alt="Live browser screen"
        src={`data:image/jpeg;base64,${frame.jpeg}`}
      />
    </div>
  );
}
