export const BAR_STYLE = `
  #bar { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; margin: 0; }
  #bar button { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; color: var(--text); background: var(--row); border: 1px solid #262633; border-radius: 6px; cursor: pointer; touch-action: manipulation; }
  #bar button:hover:not(:disabled) { border-color: var(--signal); }
  #bar button:focus-visible { outline: 1px solid var(--signal); outline-offset: 1px; }
  #bar button:disabled { color: #4f4f60; cursor: default; }
  #bar svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  #address { flex: 1; min-width: 0; height: 32px; padding: 0 14px; color: var(--text); background: var(--mantle); border: 1px solid #262633; border-radius: 16px; font: inherit; text-overflow: ellipsis; }
  #address:focus { outline: none; border-color: var(--signal); }
  #address:disabled { color: var(--dim); }
  #address::placeholder { color: var(--dim); }
  #navnote { padding: 6px 16px; background: #2a1219; color: var(--error); border-bottom: 1px solid #1d1d26; font-size: 12px; overflow-wrap: anywhere; }
  #navnote[hidden] { display: none; }
`;

export const BAR_MARKUP = `<form id="bar" role="toolbar" aria-label="Controls for the fleet browser tab" autocomplete="off">
      <button type="button" id="back" disabled>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8H3m5-5L3 8l5 5"/></svg>
      </button>
      <button type="button" id="forward" disabled>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M8 3l5 5-5 5"/></svg>
      </button>
      <button type="button" id="reload" disabled>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2v3.2h-3.2"/></svg>
      </button>
      <input id="address" type="text" inputmode="url" enterkeyhint="go" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Address of the fleet browser tab" placeholder="Enter an address for this tab" disabled>
    </form>`;

export const BAR_NOTE = `<div id="navnote" role="alert" hidden></div>`;

export const BAR_SCRIPT = `
const address = document.getElementById("address");
const bar = document.getElementById("bar");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const reloadButton = document.getElementById("reload");
const navnote = document.getElementById("navnote");

const KEYS = mac ? { back: "Cmd+[", forward: "Cmd+]", reload: "Cmd+R", address: "Cmd+L" } : { back: "Alt+Left", forward: "Alt+Right", reload: "Ctrl+R", address: "Ctrl+L" };
const labelled = (button, label, keys) => {
  button.setAttribute("aria-label", label);
  button.title = label + " (" + keys + ")";
};
labelled(backButton, "Back in this tab", KEYS.back);
labelled(forwardButton, "Forward in this tab", KEYS.forward);
labelled(reloadButton, "Reload this tab", KEYS.reload);
hint.textContent = "Click the picture to focus it. Mouse and keys act on the tab. " + KEYS.back + " and " + KEYS.forward + " go back and forward, " + KEYS.reload + " reloads, " + KEYS.address + " edits the address. Cmd or Ctrl+C copies, Cmd or Ctrl+V pastes. The buttons and the address above act on this tab, not on your own browser.";

let current;
let busy = false;
let noteTimer = 0;

function toolbar() {
  const shown = current !== undefined && current.live;
  backButton.disabled = busy || !shown || !current.canBack;
  forwardButton.disabled = busy || !shown || !current.canForward;
  reloadButton.disabled = busy || !shown;
  address.disabled = !shown;
  if (document.activeElement !== address) address.value = shown ? current.url : "";
}

function noteNav(text) {
  clearTimeout(noteTimer);
  navnote.hidden = text === "";
  navnote.textContent = text;
  if (text !== "") noteTimer = setTimeout(() => noteNav(""), 8000);
}

async function request(target, body) {
  const response = await fetch("/api/nav", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, ...body }) });
  const answer = await response.json();
  if (!response.ok) throw new Error(answer.error ?? "the tab did not answer");
}

async function navigation(body) {
  if (selected === null || busy) return;
  const target = selected;
  busy = true;
  toolbar();
  noteNav("");
  try {
    await ordered(() => request(target, body));
    if (body.action !== "open") return;
    address.blur();
    if (!isPhone()) capture.focus({ preventScroll: true });
  } catch (error) {
    noteNav(error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
    await refresh();
  }
}

const step = (action) => (event) => {
  void navigation({ action });
  if (event !== undefined && event.detail > 0 && !isPhone()) capture.focus({ preventScroll: true });
};
backButton.addEventListener("click", step("back"));
forwardButton.addEventListener("click", step("forward"));
reloadButton.addEventListener("click", step("reload"));
bar.addEventListener("submit", (event) => {
  event.preventDefault();
  const typed = address.value.trim();
  if (typed !== "") void navigation({ action: "open", url: typed });
});
address.addEventListener("focus", () => address.select());
address.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  address.blur();
  toolbar();
});

const HISTORY_BUTTONS = { 3: "back", 4: "forward" };
const historyButton = (event) => event.target === screen && Object.hasOwn(HISTORY_BUTTONS, event.button);

window.addEventListener("mousedown", (event) => {
  if (!historyButton(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  step(HISTORY_BUTTONS[event.button])();
}, true);
for (const name of ["mouseup", "auxclick"]) {
  window.addEventListener(name, (event) => {
    if (!historyButton(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function focusAddress() {
  if (!address.disabled) address.focus();
}

function shortcutFor(event) {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "F5") return step("reload");
  const bare = !event.shiftKey && !event.altKey;
  if (mac && event.metaKey && !event.ctrlKey && bare) {
    if (key === "[") return step("back");
    if (key === "]") return step("forward");
  }
  if (!mac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (key === "ArrowLeft") return step("back");
    if (key === "ArrowRight") return step("forward");
  }
  const accelerator = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (accelerator && !event.altKey && key === "r") return step("reload");
  if (accelerator && bare && key === "l") return focusAddress;
  return undefined;
}
`;
