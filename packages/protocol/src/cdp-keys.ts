interface Named {
  readonly code: string;
  readonly keyCode: number;
  readonly text?: string;
}

const NAMED: Readonly<Record<string, Named>> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

function describe(key: string): Named {
  const named = NAMED[key];
  if (named !== undefined) return named;
  if (Array.from(key).length !== 1)
    throw new Error(
      `unknown key ${key}: use a single character or one of ${Object.keys(NAMED).join(", ")}`,
    );
  const upper = key.toUpperCase();
  const keyCode = /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0;
  const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(upper) ? `Digit${upper}` : "";
  return { code, keyCode, text: key };
}

export function keyPresses(key: string): Record<string, unknown>[] {
  const { code, keyCode, text } = describe(key);
  const base = { key, code, windowsVirtualKeyCode: keyCode };
  const down =
    text === undefined ? { type: "rawKeyDown", ...base } : { type: "keyDown", ...base, text };
  return [down, { type: "keyUp", ...base }];
}
