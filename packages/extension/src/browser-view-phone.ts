export const PHONE_STYLE = `
  #keyboard, #dock { display: none; }
  .phone body { display: flex; flex-direction: column; height: 100dvh; touch-action: manipulation; }
  .phone aside { flex: none; flex-direction: row; align-items: stretch; border-right: 0; border-bottom: 1px solid #1d1d26; overflow-x: auto; overflow-y: hidden; }
  .phone aside h1 { display: none; }
  .phone #problem { flex: none; margin: 6px 10px; }
  .phone ul { display: flex; }
  .phone li { flex: none; max-width: 75vw; padding: 8px 14px; border-left: 0; border-bottom: 2px solid transparent; }
  .phone li.selected { border-bottom-color: var(--signal); }
  .phone li .host { display: none; }
  .phone main { flex: 1; min-height: 0; }
  .phone header { gap: 8px; padding: 6px 10px; min-height: 40px; }
  .phone #copied, .phone #hint { display: none; }
  .phone #stage { padding: 0; align-items: stretch; }
  .phone #screen { width: 100%; height: 100%; max-width: none; max-height: none; object-fit: contain; border: 0; border-radius: 0; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  .phone #keyboard { display: inline-block; min-height: 32px; padding: 0 12px; color: var(--text); background: var(--row); border: 1px solid #262633; border-radius: 6px; font: inherit; }
  .phone #keyboard[aria-pressed="true"] { color: var(--ink); background: var(--signal); border-color: var(--signal); }
  .phone #dock:not([hidden]) { display: flex; flex-direction: column; flex: none; gap: 6px; padding: 6px 8px calc(6px + env(safe-area-inset-bottom)); background: var(--mantle); border-top: 1px solid #1d1d26; }
  #keys { display: flex; gap: 4px; }
  #keys button { flex: 1 1 0; min-width: 0; min-height: 40px; padding: 0 4px; color: var(--text); background: var(--row); border: 1px solid #262633; border-radius: 6px; font: inherit; touch-action: manipulation; }
  #typer { width: 100%; min-height: 44px; padding: 0 12px; color: var(--text); background: var(--row); border: 1px solid #262633; border-radius: 6px; font: inherit; font-size: 16px; }
  #typer:focus { outline: 1px solid var(--signal); }
`;

export const PHONE_HEAD = `
<script>
  const phoneQuery = matchMedia("(max-width: 640px), (pointer: coarse)");
  document.documentElement.classList.toggle("phone", phoneQuery.matches);
</script>`;

export const PHONE_KEYBOARD = `<button id="keyboard" type="button" aria-pressed="false">Keyboard</button>`;

export const PHONE_DOCK = `
  <div id="dock" hidden>
    <div id="keys">
      <button type="button" data-key="Escape">Esc</button>
      <button type="button" data-key="Tab">Tab</button>
      <button type="button" data-key="ArrowLeft" aria-label="Left">&larr;</button>
      <button type="button" data-key="ArrowUp" aria-label="Up">&uarr;</button>
      <button type="button" data-key="ArrowDown" aria-label="Down">&darr;</button>
      <button type="button" data-key="ArrowRight" aria-label="Right">&rarr;</button>
      <button type="button" data-key="Backspace" aria-label="Backspace">&#9003;</button>
      <button type="button" data-key="Enter" aria-label="Enter">&crarr;</button>
    </div>
    <input id="typer" type="text" inputmode="text" enterkeyhint="send" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Type here, it goes to the page" aria-label="Type into the page">
  </div>`;

export const PHONE_SCRIPT = `
const NAMED_KEYS = { Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Enter: 13 };

function phoneTap(at) {
  const touch = { x: at.x, y: at.y, button: "left", clickCount: 1, modifiers: 0 };
  send({ kind: "mouse", action: "down", ...touch, buttons: 1 });
  send({ kind: "mouse", action: "up", ...touch, buttons: 0 });
}

function phoneScroll(at, dx, dy) {
  send({ kind: "scroll", x: at.x, y: at.y, dx, dy, modifiers: 0 });
}

function phoneKey(key) {
  const keyCode = NAMED_KEYS[key];
  if (keyCode === undefined) {
    send({ kind: "text", text: key });
    return;
  }
  const base = { kind: "key", key, code: key, keyCode, location: 0, repeat: false, modifiers: 0, commands: [] };
  send({ ...base, action: "down" });
  send({ ...base, action: "up" });
}

const dock = document.getElementById("dock");
const typer = document.getElementById("typer");
const keyboardButton = document.getElementById("keyboard");
const isPhone = () => document.documentElement.classList.contains("phone");

const TAP_SLOP = 10;
const FIT_DEBOUNCE_MS = 250;
const TOUCH_QUIET_MS = 800;
let lastTouch = 0;
let fitted = "";
let fitTimer = 0;
let refused = null;

function fitNow() {
  if (!isPhone() || selected === null || refused === selected) return;
  const box = stage.getBoundingClientRect();
  const width = Math.floor(box.width);
  const height = Math.floor(box.height);
  if (width < 200 || height < 200) return;
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const key = [selected, width, height, scale].join(":");
  if (key === fitted) return;
  fitted = key;
  void postFit({ target: selected, width, height, scale });
}

let fitting = false;
let wanted = null;

async function postFit(body) {
  wanted = body;
  if (fitting) return;
  fitting = true;
  while (wanted !== null) {
    const sending = wanted;
    wanted = null;
    const status = await fetch("/api/fit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sending) })
      .then((response) => response.status, () => 0);
    if (sending.clear === true) continue;
    if (status === 404) refused = sending.target;
    else if (status !== 204 && wanted === null) fitted = "";
  }
  fitting = false;
}

function phoneTargetChanged() {
  resetTyper();
  refused = null;
}

function scheduleFit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitNow, FIT_DEBOUNCE_MS);
}

function refit() {
  fitted = "";
  scheduleFit();
}

new ResizeObserver(scheduleFit).observe(stage);

function phonePoint(clientX, clientY) {
  const box = screen.getBoundingClientRect();
  const scale = Math.min(box.width / size.width, box.height / size.height);
  const left = box.left + (box.width - size.width * scale) / 2;
  const top = box.top + (box.height - size.height * scale) / 2;
  return {
    x: Math.min(size.width, Math.max(0, (clientX - left) / scale)),
    y: Math.min(size.height, Math.max(0, (clientY - top) / scale)),
  };
}

let gesture = null;
let scrollFrame = 0;

function flushScroll() {
  scrollFrame = 0;
  if (gesture === null || (gesture.dx === 0 && gesture.dy === 0)) return;
  const at = phonePoint(gesture.x, gesture.y);
  phoneScroll(at, gesture.dx, gesture.dy);
  gesture.dx = 0;
  gesture.dy = 0;
}

screen.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch") return;
  event.preventDefault();
  lastTouch = Date.now();
  if (gesture !== null) return;
  screen.setPointerCapture(event.pointerId);
  gesture = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, dx: 0, dy: 0, moved: false };
});

screen.addEventListener("pointermove", (event) => {
  if (gesture === null || event.pointerId !== gesture.id) return;
  lastTouch = Date.now();
  gesture.dx += gesture.x - event.clientX;
  gesture.dy += gesture.y - event.clientY;
  gesture.x = event.clientX;
  gesture.y = event.clientY;
  if (!gesture.moved && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < TAP_SLOP) {
    gesture.dx = 0;
    gesture.dy = 0;
    return;
  }
  gesture.moved = true;
  if (scrollFrame === 0) scrollFrame = requestAnimationFrame(flushScroll);
});

screen.addEventListener("pointerup", (event) => {
  if (gesture === null || event.pointerId !== gesture.id) return;
  lastTouch = Date.now();
  cancelAnimationFrame(scrollFrame);
  flushScroll();
  if (!gesture.moved) {
    resetTyper();
    phoneTap(phonePoint(event.clientX, event.clientY));
  }
  gesture = null;
});

screen.addEventListener("pointercancel", () => {
  cancelAnimationFrame(scrollFrame);
  gesture = null;
});

screen.addEventListener("contextmenu", (event) => event.preventDefault());

for (const name of ["click", "mousedown", "mouseup", "mousemove"]) {
  window.addEventListener(name, (event) => {
    if (event.target === screen && Date.now() - lastTouch < TOUCH_QUIET_MS) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  }, true);
}

let mirrored = "";

function resetTyper() {
  typer.value = "";
  mirrored = "";
}

function mirror() {
  const before = Array.from(mirrored);
  const after = Array.from(typer.value);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common += 1;
  for (let removed = before.length; removed > common; removed -= 1) phoneKey("Backspace");
  for (const char of after.slice(common)) phoneKey(char);
  mirrored = typer.value;
}

typer.addEventListener("input", mirror);
typer.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    phoneKey("Enter");
    resetTyper();
  } else if (event.key === "Backspace" && typer.value === "") {
    event.preventDefault();
    phoneKey("Backspace");
  }
});

document.getElementById("keys").addEventListener("pointerdown", (event) => event.preventDefault());
document.getElementById("keys").addEventListener("click", (event) => {
  const key = event.target instanceof Element ? event.target.closest("button")?.dataset.key : undefined;
  if (key === undefined) return;
  phoneKey(key);
  resetTyper();
});

function toggleKeyboard() {
  const open = dock.hidden;
  dock.hidden = !open;
  keyboardButton.setAttribute("aria-pressed", String(open));
  if (open) typer.focus();
  else typer.blur();
}

keyboardButton.addEventListener("click", toggleKeyboard);

phoneQuery.addEventListener("change", () => {
  document.documentElement.classList.toggle("phone", phoneQuery.matches);
  if (phoneQuery.matches) refit();
  else if (selected !== null) {
    fitted = "";
    void postFit({ target: selected, clear: true });
  }
});

if (window.visualViewport !== null && window.visualViewport !== undefined) {
  const follow = () => {
    if (!isPhone()) return;
    document.body.style.height = window.visualViewport.height + "px";
    document.body.style.transform = "translateY(" + window.visualViewport.offsetTop + "px)";
  };
  window.visualViewport.addEventListener("resize", follow);
  window.visualViewport.addEventListener("scroll", follow);
}
`;
