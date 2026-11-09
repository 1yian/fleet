import { EDITING_COMMANDS } from "./browser-input.ts";
import { BAR_MARKUP, BAR_NOTE, BAR_SCRIPT, BAR_STYLE } from "./browser-view-bar.ts";
import {
  PHONE_DOCK,
  PHONE_HEAD,
  PHONE_KEYBOARD,
  PHONE_SCRIPT,
  PHONE_STYLE,
} from "./browser-view-phone.ts";

export const VIEWER_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fleet browser</title>
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<style>
  :root { color-scheme: dark; --ink: #101014; --mantle: #0c0c10; --row: #16161d; --text: #e6e6ea; --dim: #8b8b99; --signal: #3dffc0; --error: #ff5c7a; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: grid; grid-template-columns: 300px 1fr; background: var(--ink); color: var(--text); font: 14px/1.4 ui-monospace, "JetBrains Mono", Menlo, monospace; }
  aside { background: var(--mantle); border-right: 1px solid #1d1d26; overflow-y: auto; display: flex; flex-direction: column; }
  h1 { margin: 0; padding: 16px 16px 12px; font-size: 13px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--signal); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 10px 16px; cursor: pointer; border-left: 2px solid transparent; }
  li:hover { background: var(--row); }
  li.selected { background: var(--row); border-left-color: var(--signal); }
  li .card { font-weight: 600; }
  li .host { color: var(--dim); font-size: 12px; }
  li .page { color: var(--dim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  li.gone .card { color: var(--dim); text-decoration: line-through; }
  #problem { margin: 0 16px 12px; padding: 8px 10px; background: #2a1219; color: var(--error); border-radius: 4px; font-size: 12px; }
  #problem[hidden] { display: none; }
  main { display: flex; flex-direction: column; min-width: 0; }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid #1d1d26; min-height: 48px; }
  #live { color: var(--dim); font-size: 12px; }
  #live.on { color: var(--signal); }
  #copied { max-width: 420px; color: var(--signal); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #copied.failed { color: var(--error); }
  #copied.empty { color: var(--dim); }
  #stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 16px; }
  #screen { max-width: 100%; max-height: 100%; outline: none; border: 1px solid #262633; border-radius: 4px; cursor: default; background: #fff; user-select: none; -webkit-user-select: none; touch-action: none; }
  #stage:focus-within #screen { border-color: var(--signal); }
  #capture { position: absolute; left: 0; top: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; resize: none; overflow: hidden; pointer-events: none; font-size: 16px; caret-color: transparent; }
  #note { max-width: 640px; padding: 16px 20px; background: var(--row); color: var(--dim); border: 1px solid #262633; border-radius: 4px; }
  #note[hidden] { display: none; }
  #hint { padding: 0 16px 10px; color: var(--dim); font-size: 12px; }
${BAR_STYLE}${PHONE_STYLE}</style>${PHONE_HEAD}
</head>
<body>
<aside>
  <h1>Browser</h1>
  <div id="problem" hidden></div>
  <ul id="tabs"></ul>
</aside>
<main>
  <header>
    ${BAR_MARKUP}
    <span id="copied" role="status"></span>
    ${PHONE_KEYBOARD}
    <span id="live" hidden></span>
  </header>
  ${BAR_NOTE}
  <div id="stage">
    <img id="screen" alt="" hidden draggable="false">
    <textarea id="capture" aria-label="Keyboard input for the page" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" tabindex="-1"></textarea>
    <div id="note" hidden></div>
  </div>
  <div id="hint" hidden></div>
  ${PHONE_DOCK}
</main>
<script>
const list = document.getElementById("tabs");
const hint = document.getElementById("hint");
const problem = document.getElementById("problem");
const live = document.getElementById("live");
const screen = document.getElementById("screen");
const note = document.getElementById("note");
const capture = document.getElementById("capture");
const stage = document.getElementById("stage");
const copied = document.getElementById("copied");
let selected = null;
let source = null;
let size = { width: 1, height: 1 };
let acknowledging = () => undefined;
let newest = 0;
screen.addEventListener("load", () => acknowledging());
screen.addEventListener("error", () => acknowledging());

const EDITING = ${JSON.stringify(EDITING_COMMANDS)};
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const editing = mac ? EDITING.mac : EDITING.other;

const pending = [];
let flowing = false;

function enqueue(body) {
  const last = pending[pending.length - 1];
  if (last !== undefined && last.target === body.target) {
    if (last.kind === "mouse" && body.kind === "mouse" && last.action === "move" && body.action === "move") {
      pending[pending.length - 1] = body;
      return;
    }
    if (last.kind === "scroll" && body.kind === "scroll" && last.modifiers === body.modifiers) {
      pending[pending.length - 1] = { ...body, dx: last.dx + body.dx, dy: last.dy + body.dy };
      return;
    }
  }
  pending.push(body);
}

async function flow() {
  if (flowing) return;
  flowing = true;
  while (pending.length > 0) {
    if (typeof pending[0] === "function") {
      await pending.shift()();
      continue;
    }
    const batch = [pending.shift()];
    while (pending.length > 0 && typeof pending[0] !== "function" && pending[0].target === batch[0].target) batch.push(pending.shift());
    try {
      const response = await fetch("/api/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch) });
      if (!response.ok) throw new Error((await response.json()).error ?? "the tab did not accept input");
    } catch (error) {
      noteNav("Input failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  flowing = false;
}

function ordered(run) {
  return new Promise((resolve, reject) => {
    pending.push(async () => {
      try {
        resolve(await run());
      } catch (error) {
        reject(error);
      }
    });
    void flow();
  });
}

function send(body, target = selected) {
  if (target === null) return;
  enqueue({ target, ...body });
  void flow();
}

const held = new Map();
const MODIFIER_KEYS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const heldModifiers = () => [...held.values()].reduce((bits, { key }) => bits | (MODIFIER_KEYS[key] ?? 0), 0);

function releaseKeys() {
  for (const { target, ...key } of [...held.values()].reverse()) {
    held.delete(key.code);
    send({ kind: "key", action: "up", ...key, repeat: false, modifiers: heldModifiers(), commands: [] }, target);
  }
}

const modifiersOf = (event) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);

function point(event) {
  const box = screen.getBoundingClientRect();
  return {
    x: ((event.clientX - box.left - screen.clientLeft) / screen.clientWidth) * size.width,
    y: ((event.clientY - box.top - screen.clientTop) / screen.clientHeight) * size.height,
  };
}

function idle(message) {
  screen.removeAttribute("src");
  screen.hidden = true;
  live.hidden = true;
  hint.hidden = true;
  current = undefined;
  toolbar();
  note.hidden = false;
  note.textContent = message;
}

const ACK_TIMEOUT_MS = 3000;
const ACK_TRIES = 3;
const ACK_BACKOFF_MS = 250;
const RESET_GAP_MS = 5000;
let lastReset = 0;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acknowledge(mine, id, seq, target) {
  const unreleased = () => source === mine && newest === seq;
  for (let attempt = 0; attempt < ACK_TRIES; attempt += 1) {
    if (attempt > 0) await pause(ACK_BACKOFF_MS * attempt);
    if (!unreleased()) return;
    const status = await fetch("/api/ack?id=" + id + "&seq=" + seq, { method: "POST", keepalive: true, signal: AbortSignal.timeout(ACK_TIMEOUT_MS) })
      .then((response) => response.status, () => 0);
    if (status === 204) return;
    if (status === 404) break;
  }
  if (unreleased()) reset(mine, target);
}

function reset(mine, target) {
  const wait = Math.max(0, lastReset + RESET_GAP_MS - Date.now());
  lastReset = Date.now() + wait;
  setTimeout(() => { if (source === mine) connect(target); }, wait);
}

function closeStream() {
  if (source !== null) source.close();
  source = null;
}

function connect(target) {
  closeStream();
  live.textContent = "connecting";
  live.className = "";
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const mine = new EventSource("/api/stream?target=" + encodeURIComponent(target) + "&id=" + id);
  source = mine;
  newest = 0;
  acknowledging = () => undefined;
  mine.onopen = refit;
  mine.onmessage = (message) => {
    const shown = JSON.parse(message.data);
    newest = shown.seq;
    acknowledging = () => acknowledge(mine, id, shown.seq, target);
    if (shown.hidden !== undefined) {
      screen.removeAttribute("src");
      screen.hidden = true;
      note.hidden = false;
      note.textContent = "Hidden: " + shown.hidden + ". The captain's viewer in main's workspace shows this page.";
      live.textContent = "hidden";
      live.className = "";
      acknowledging();
      return;
    }
    note.hidden = true;
    screen.hidden = false;
    size = { width: shown.width, height: shown.height };
    screen.src = "data:image/jpeg;base64," + shown.data;
    live.textContent = "live";
    live.className = "on";
  };
  mine.onerror = () => { live.textContent = "reconnecting"; live.className = ""; };
}

function watch(target) {
  releaseKeys();
  if (target !== selected) phoneTargetChanged();
  selected = target;
  if (target === null) {
    closeStream();
    return;
  }
  screen.hidden = false;
  note.hidden = true;
  live.hidden = false;
  hint.hidden = false;
  connect(target);
}

function render(tabs) {
  list.replaceChildren();
  for (const tab of tabs) {
    const item = document.createElement("li");
    item.dataset.target = tab.target;
    item.className = (tab.target === selected ? "selected " : "") + (tab.live ? "" : "gone");
    const card = document.createElement("div");
    card.className = "card";
    card.textContent = tab.label;
    const where = document.createElement("div");
    where.className = "host";
    where.textContent = tab.host;
    const page = document.createElement("div");
    page.className = "page";
    page.textContent = tab.live ? tab.title || tab.url : "tab is gone";
    item.append(card, where, page);
    item.onclick = () => {
      if (!tab.live) return;
      watch(tab.target);
      render(tabs);
      if (!isPhone()) capture.focus();
    };
    list.append(item);
  }
  current = tabs.find((tab) => tab.target === selected);
  toolbar();
  if (selected !== null && !tabs.some((tab) => tab.target === selected && tab.live)) watch(null);
  const shown = tabs.filter((tab) => tab.live);
  if (selected === null && tabs.length === 1 && shown.length === 1) {
    watch(shown[0].target);
    render(tabs);
  }
  if (selected === null) {
    idle(shown.length === 0
      ? "No tabs open. Each card gets its own tab when its worker opens a page."
      : "Pick a tab on the left.");
  }
}

async function refresh() {
  try {
    const answer = await (await fetch("/api/tabs")).json();
    problem.hidden = answer.problem === null;
    problem.textContent = answer.problem ?? "";
    render(answer.tabs);
  } catch {
    problem.hidden = false;
    problem.textContent = "The viewer lost its server";
  }
}

const BUTTONS = ["left", "middle", "right", "back", "forward"];
const heldButton = (buttons) => (buttons & 1 ? "left" : buttons & 4 ? "middle" : buttons & 2 ? "right" : buttons & 8 ? "back" : buttons & 16 ? "forward" : "none");
let pressed = false;
let over = false;
let ctrlClick = false;
let downButton = "left";

function mouse(action, event, lost) {
  const buttons = ctrlClick ? (event.buttons === 0 ? 0 : 2) : event.buttons;
  const named = ctrlClick ? "right" : BUTTONS[event.button] ?? "left";
  const button = action === "move" ? heldButton(buttons) : lost ? downButton : named;
  const modifiers = modifiersOf(event) & (ctrlClick ? ~2 : 15);
  send({ kind: "mouse", action, ...point(event), button, buttons, clickCount: Math.min(3, Math.max(1, event.detail)), modifiers });
}

function leave(event) {
  if (!over || pressed) return;
  over = false;
  mouse("move", event, false);
}

function release(event, lost) {
  mouse("up", event, lost);
  pressed = event.buttons !== 0;
  if (!pressed) ctrlClick = false;
}

screen.addEventListener("mousedown", (event) => {
  event.preventDefault();
  const box = stage.getBoundingClientRect();
  capture.style.left = event.clientX - box.left + "px";
  capture.style.top = event.clientY - box.top + "px";
  capture.focus({ preventScroll: true });
  ctrlClick = mac && event.ctrlKey && event.button === 0;
  downButton = ctrlClick ? "right" : BUTTONS[event.button] ?? "left";
  pressed = true;
  over = true;
  mouse("down", event, false);
});
window.addEventListener("mousemove", (event) => {
  if (pressed && event.buttons === 0) release(event, true);
  else if (pressed || event.target === screen) {
    over = event.target === screen;
    mouse("move", event, false);
  } else leave(event);
});
screen.addEventListener("mouseleave", leave);
window.addEventListener("mouseup", (event) => {
  if (pressed) release(event, false);
});
screen.addEventListener("contextmenu", (event) => event.preventDefault());
screen.addEventListener("wheel", (event) => {
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? screen.clientHeight : 1;
  send({ kind: "scroll", ...point(event), dx: event.deltaX * unit, dy: event.deltaY * unit, modifiers: modifiersOf(event) });
}, { passive: false });

const HOST_ZOOM = ["+", "=", "-", "0"];
const HOST_WINDOW = ["t", "w", "n", "q"];
const HOST_TOOLS = ["KeyI", "KeyJ", "KeyC"];

function keepsForHost(event) {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (["F11", "F12"].includes(key)) return true;
  if (event.ctrlKey && ["Tab", "PageUp", "PageDown"].includes(key)) return true;
  if (mac && event.ctrlKey && event.metaKey) return key === "f";
  const accelerator = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!accelerator) return false;
  if (mac && event.altKey) return HOST_TOOLS.includes(event.code);
  if (!mac && event.shiftKey && HOST_TOOLS.includes(event.code)) return true;
  return HOST_WINDOW.includes(key) || HOST_ZOOM.includes(key) || /^[1-9]$/.test(key) || (mac && (key === "h" || key === "m"));
}

let composing = false;

function keyboard(action, event) {
  const typing = mac && event.altKey && !event.metaKey && !event.ctrlKey && Array.from(event.key).length === 1;
  const modifiers = modifiersOf(event) & (typing ? ~1 : 15);
  const command = action === "down" ? editing[modifiers + ":" + event.key.toLowerCase()] : undefined;
  return { kind: "key", action, key: event.key, code: event.code, keyCode: event.keyCode, location: event.location, repeat: event.repeat, modifiers, commands: command === undefined ? [] : [command] };
}

const unreadable = (event) => composing || event.isComposing || event.keyCode === 229 || ["Dead", "Process", "Unidentified"].includes(event.key);

capture.addEventListener("keydown", (event) => {
  if (selected === null) return;
  const shortcut = unreadable(event) ? undefined : shortcutFor(event);
  if (shortcut !== undefined) {
    event.preventDefault();
    shortcut();
    return;
  }
  if (keepsForHost(event) || unreadable(event)) return;
  const accelerator = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const letter = event.key.toLowerCase();
  if (accelerator && !event.altKey && letter === "v") return;
  event.preventDefault();
  if (accelerator && !event.altKey && (letter === "c" || letter === "x")) {
    if (letter === "c") void copy();
    return;
  }
  send(keyboard("down", event));
  if (mac && event.metaKey && event.key !== "Meta") send(keyboard("up", event));
  else held.set(event.code, { target: selected, key: event.key, code: event.code, keyCode: event.keyCode, location: event.location });
});
capture.addEventListener("keyup", (event) => {
  if (!held.delete(event.code)) return;
  event.preventDefault();
  send(keyboard("up", event));
});
capture.addEventListener("blur", releaseKeys);

capture.addEventListener("compositionstart", () => { composing = true; });
capture.addEventListener("compositionend", (event) => {
  composing = false;
  if (event.data) send({ kind: "text", text: event.data });
  capture.value = "";
});
capture.addEventListener("input", (event) => {
  if (composing || event.isComposing) return;
  if (event.inputType === "insertText" && event.data) send({ kind: "text", text: event.data });
  capture.value = "";
});
capture.addEventListener("paste", (event) => {
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text !== "") send({ kind: "text", text });
});
capture.addEventListener("copy", (event) => {
  event.preventDefault();
  void copy();
});

let forgetting = 0;
function say(text, state) {
  copied.textContent = text;
  copied.title = text;
  copied.className = state;
  clearTimeout(forgetting);
  forgetting = setTimeout(() => { copied.textContent = ""; copied.title = ""; }, 5000);
}

function selection(target) {
  return ordered(async () => {
    const response = await fetch("/api/copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }) });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error ?? "the viewer could not read the selection");
    if (answer.text === null) throw new Error(answer.note ?? "nothing was copied");
    if (answer.text === "") throw Object.assign(new Error("nothing is selected"), { empty: true });
    return answer.text;
  });
}

async function write(read) {
  if (navigator.clipboard === undefined) throw new Error("this browser does not allow the viewer to write to the clipboard");
  if (typeof ClipboardItem === "undefined") {
    const text = await read;
    await navigator.clipboard.writeText(text);
    return text;
  }
  let text = "";
  const blob = read.then((value) => { text = value; return new Blob([value], { type: "text/plain" }); });
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  } catch (error) {
    await read;
    throw error;
  }
  return text;
}

async function copy() {
  if (selected === null) return;
  try {
    const text = await write(selection(selected));
    say("copied " + Array.from(text).length + " characters", "");
  } catch (error) {
    say(error instanceof Error ? error.message : String(error), error.empty === true ? "empty" : "failed");
  }
}
${BAR_SCRIPT}
${PHONE_SCRIPT}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
