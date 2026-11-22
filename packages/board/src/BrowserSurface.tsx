import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
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

function mouseInput(
  event: PointerEvent<HTMLDivElement>,
  frame: BrowserFrame,
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
): BrowserInput {
  return {
    t: "mouse",
    type,
    ...position(frame, event, event.currentTarget),
    button: ["left", "middle", "right"][event.button] ?? "none",
    buttons: event.buttons,
    clickCount: type === "mouseMoved" ? 0 : Math.max(1, event.detail),
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

export function BrowserSurface({ frame, driving, input }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const target = frame.meta.targetId;
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
      if (
        event.nativeEvent.isComposing ||
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v")
      )
        return;
      event.preventDefault();
      input(target, keyInput(event, down));
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
        input(target, mouseInput(event, frame, "mousePressed"));
      }}
      onPointerMove={(event) => {
        if (driving) input(target, mouseInput(event, frame, "mouseMoved"));
      }}
      onPointerUp={(event) => {
        if (driving && event.currentTarget.hasPointerCapture(event.pointerId))
          input(target, mouseInput(event, frame, "mouseReleased"));
      }}
      onContextMenu={(event) => {
        if (driving) event.preventDefault();
      }}
      onPaste={(event) => {
        if (!driving) return;
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        if (text) input(target, { t: "text", text: text.slice(0, 8192) });
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
