import Type, { type Static } from "typebox";

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;
const KEYPAD = 3;

const BUTTONS = ["none", "left", "middle", "right", "back", "forward"] as const;

const BUTTON_BIT: Readonly<Record<(typeof BUTTONS)[number], number>> = {
  none: 0,
  left: 1,
  right: 2,
  middle: 4,
  back: 8,
  forward: 16,
};

const SELECTING = "AndModifySelection";

const MAC_MOVES: readonly (readonly [number, string, string])[] = [
  [META, "arrowleft", "moveToBeginningOfLine"],
  [META, "arrowright", "moveToEndOfLine"],
  [META, "arrowup", "moveToBeginningOfDocument"],
  [META, "arrowdown", "moveToEndOfDocument"],
  [ALT, "arrowleft", "moveWordLeft"],
  [ALT, "arrowright", "moveWordRight"],
];

const withSelecting = (moves: typeof MAC_MOVES): Record<string, string> =>
  Object.fromEntries(
    moves.flatMap(([modifiers, key, command]) => [
      [`${String(modifiers)}:${key}`, command],
      [`${String(modifiers | SHIFT)}:${key}`, `${command}${SELECTING}`],
    ]),
  );

const editing = (accelerator: number): Record<string, string> => ({
  [`${String(accelerator)}:a`]: "selectAll",
  [`${String(accelerator)}:z`]: "undo",
  [`${String(accelerator | SHIFT)}:z`]: "redo",
});

export const EDITING_COMMANDS = {
  mac: {
    ...editing(META),
    ...withSelecting(MAC_MOVES),
    [`${String(ALT)}:backspace`]: "deleteWordBackward",
    [`${String(ALT)}:delete`]: "deleteWordForward",
    [`${String(META)}:backspace`]: "deleteToBeginningOfLine",
  },
  other: { ...editing(CTRL), [`${String(CTRL)}:y`]: "redo" },
} as const;

const COMMANDS = [
  ...new Set([...Object.values(EDITING_COMMANDS.mac), ...Object.values(EDITING_COMMANDS.other)]),
];

const Target = Type.String();
const Point = { x: Type.Number(), y: Type.Number() };
const Modifiers = Type.Integer({ minimum: 0, maximum: 15 });

export const InputSchema = Type.Union([
  Type.Object({
    target: Target,
    kind: Type.Literal("mouse"),
    action: Type.Enum(["move", "down", "up"]),
    ...Point,
    button: Type.Enum(BUTTONS),
    buttons: Type.Integer({ minimum: 0, maximum: 31 }),
    clickCount: Type.Integer({ minimum: 1, maximum: 3 }),
    modifiers: Modifiers,
  }),
  Type.Object({
    target: Target,
    kind: Type.Literal("scroll"),
    ...Point,
    dx: Type.Number(),
    dy: Type.Number(),
    modifiers: Modifiers,
  }),
  Type.Object({
    target: Target,
    kind: Type.Literal("key"),
    action: Type.Enum(["down", "up"]),
    key: Type.String({ minLength: 1 }),
    code: Type.String(),
    keyCode: Type.Integer({ minimum: 0 }),
    location: Type.Integer({ minimum: 0, maximum: 3 }),
    repeat: Type.Boolean(),
    modifiers: Modifiers,
    commands: Type.Array(Type.Enum(COMMANDS)),
  }),
  Type.Object({ target: Target, kind: Type.Literal("text"), text: Type.String() }),
]);
export type ViewerInput = Static<typeof InputSchema>;

export interface Call {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const MOUSE_TYPES = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;

const mouseCalls = (event: Extract<ViewerInput, { kind: "mouse" }>): Call[] => {
  const { x, y, button, buttons, clickCount, modifiers } = event;
  const press = event.action === "down" && clickCount === 1;
  const params = (type: string, which: string, held: number, count: number): Call => ({
    method: "Input.dispatchMouseEvent",
    params: {
      type,
      x,
      y,
      button: which,
      buttons: held,
      clickCount: count,
      modifiers,
      pointerType: "mouse",
    },
  });
  return [
    ...(press ? [params("mouseMoved", "none", buttons & ~BUTTON_BIT[button], 0)] : []),
    params(MOUSE_TYPES[event.action], button, buttons, event.action === "move" ? 0 : clickCount),
  ];
};

const isSingleCharacter = (key: string): boolean => Array.from(key).length === 1;

function typedText(key: string, modifiers: number): string | undefined {
  const command = (modifiers & META) !== 0 || ((modifiers & CTRL) !== 0 && (modifiers & ALT) === 0);
  if (command) return undefined;
  if (key === "Enter") return "\r";
  return isSingleCharacter(key) ? key : undefined;
}

interface ClipboardKeys {
  readonly names: readonly string[];
  readonly codes: readonly string[];
  readonly keyCodes: readonly number[];
}

const WITH_ACCELERATOR: ClipboardKeys = {
  names: ["c", "x", "v", "insert"],
  codes: ["KeyC", "KeyX", "KeyV", "Insert"],
  keyCodes: [67, 88, 86, 45],
};

const WITH_SHIFT: ClipboardKeys = {
  names: ["insert", "delete"],
  codes: ["Insert", "Delete"],
  keyCodes: [45, 46],
};

const isAmong = (
  { names, codes, keyCodes }: ClipboardKeys,
  { key, code, keyCode }: Extract<ViewerInput, { kind: "key" }>,
): boolean =>
  names.includes(key.toLowerCase()) || codes.includes(code) || keyCodes.includes(keyCode);

function touchesClipboard(event: Extract<ViewerInput, { kind: "key" }>): boolean {
  const { modifiers } = event;
  if ((modifiers & ALT) !== 0) return false;
  if ((modifiers & (CTRL | META)) !== 0) return isAmong(WITH_ACCELERATOR, event);
  return (modifiers & SHIFT) !== 0 && isAmong(WITH_SHIFT, event);
}

const keyCalls = (event: Extract<ViewerInput, { kind: "key" }>): Call[] => {
  if (touchesClipboard(event)) return [];
  const { key, code, keyCode, location, modifiers, commands } = event;
  const text = event.action === "down" ? typedText(key, modifiers) : undefined;
  const type = event.action === "up" ? "keyUp" : text === undefined ? "rawKeyDown" : "keyDown";
  return [
    {
      method: "Input.dispatchKeyEvent",
      params: {
        type,
        key,
        code,
        modifiers,
        location,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
        autoRepeat: event.repeat,
        isKeypad: location === KEYPAD,
        ...(text === undefined ? {} : { text, unmodifiedText: text }),
        ...(commands.length === 0 || event.action === "up" ? {} : { commands }),
      },
    },
  ];
};

export const entersText = (event: ViewerInput): boolean =>
  event.kind === "key" || event.kind === "text";

export const pastesSelection = (event: ViewerInput): boolean =>
  event.kind === "mouse" && event.button === "middle";

export function inputCalls(event: ViewerInput): Call[] {
  switch (event.kind) {
    case "mouse":
      return mouseCalls(event);
    case "scroll":
      return [
        {
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseWheel",
            x: event.x,
            y: event.y,
            deltaX: event.dx,
            deltaY: event.dy,
            modifiers: event.modifiers,
          },
        },
      ];
    case "key":
      return keyCalls(event);
    case "text":
      return [{ method: "Input.insertText", params: { text: event.text } }];
  }
}
