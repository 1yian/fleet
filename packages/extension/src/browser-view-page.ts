export const VIEWER_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fleet browser</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
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
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #1d1d26; min-height: 44px; }
  #address { flex: 1; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #live { color: var(--dim); font-size: 12px; }
  #live.on { color: var(--signal); }
  #paste { width: 220px; padding: 6px 8px; background: var(--row); color: var(--text); border: 1px solid #262633; border-radius: 4px; font: inherit; }
  #paste:focus { outline: 1px solid var(--signal); }
  #stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 16px; }
  #screen { max-width: 100%; max-height: 100%; outline: none; border: 1px solid #262633; border-radius: 4px; cursor: default; background: #fff; }
  #screen:focus { border-color: var(--signal); }
  #note { max-width: 640px; padding: 16px 20px; background: var(--row); color: var(--dim); border: 1px solid #262633; border-radius: 4px; }
  #note[hidden] { display: none; }
  #hint { padding: 0 16px 10px; color: var(--dim); font-size: 12px; }
</style>
</head>
<body>
<aside>
  <h1>Browser</h1>
  <div id="problem" hidden></div>
  <ul id="tabs"></ul>
</aside>
<main>
  <header>
    <div id="address"></div>
    <input id="paste" placeholder="Type text, then Enter" autocomplete="off" spellcheck="false" hidden>
    <span id="live" hidden></span>
  </header>
  <div id="stage"><img id="screen" tabindex="0" alt="" hidden draggable="false"><div id="note" hidden></div></div>
  <div id="hint" hidden>Click the picture to focus it. Clicks, keys and scrolling go to the tab.</div>
</main>
<script>
const list = document.getElementById("tabs");
const hint = document.getElementById("hint");
const problem = document.getElementById("problem");
const address = document.getElementById("address");
const live = document.getElementById("live");
const screen = document.getElementById("screen");
const note = document.getElementById("note");
const paste = document.getElementById("paste");
let selected = null;
let source = null;
let size = { width: 1, height: 1 };

let queue = Promise.resolve();
const send = (body) => {
  queue = queue.then(() => fetch("/api/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).catch(() => undefined);
};

function point(event) {
  const box = screen.getBoundingClientRect();
  return { x: ((event.clientX - box.left) / box.width) * size.width, y: ((event.clientY - box.top) / box.height) * size.height };
}

function idle(message) {
  screen.removeAttribute("src");
  screen.hidden = true;
  paste.hidden = true;
  live.hidden = true;
  hint.hidden = true;
  address.textContent = "";
  note.hidden = false;
  note.textContent = message;
}

function watch(target) {
  if (source !== null) source.close();
  selected = target;
  if (target === null) return;
  screen.hidden = false;
  note.hidden = true;
  paste.hidden = false;
  live.hidden = false;
  hint.hidden = false;
  live.textContent = "connecting";
  live.className = "";
  source = new EventSource("/api/stream?target=" + encodeURIComponent(target));
  source.onmessage = (message) => {
    const shown = JSON.parse(message.data);
    if (shown.hidden !== undefined) {
      screen.removeAttribute("src");
      screen.hidden = true;
      note.hidden = false;
      note.textContent = "Hidden: " + shown.hidden + ". The captain's viewer in main's workspace shows this page.";
      live.textContent = "hidden";
      live.className = "";
      return;
    }
    note.hidden = true;
    screen.hidden = false;
    size = { width: shown.width, height: shown.height };
    screen.src = "data:image/jpeg;base64," + shown.data;
    live.textContent = "live";
    live.className = "on";
  };
  source.onerror = () => { live.textContent = "reconnecting"; live.className = ""; };
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
      address.textContent = tab.url;
      watch(tab.target);
      render(tabs);
      screen.focus();
    };
    list.append(item);
    if (tab.target === selected) address.textContent = tab.live ? tab.url : "tab is gone";
  }
  if (selected !== null && !tabs.some((tab) => tab.target === selected && tab.live)) watch(null);
  const shown = tabs.filter((tab) => tab.live);
  if (selected === null && tabs.length === 1 && shown.length === 1) {
    address.textContent = shown[0].url;
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

screen.addEventListener("click", (event) => { screen.focus(); send({ target: selected, kind: "click", ...point(event) }); });
screen.addEventListener("wheel", (event) => { event.preventDefault(); send({ target: selected, kind: "scroll", ...point(event), dy: event.deltaY }); }, { passive: false });
screen.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.key.length > 1 && !event.key.startsWith("Arrow") && !["Enter", "Tab", "Escape", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
  event.preventDefault();
  send({ target: selected, kind: "key", key: event.key });
});
paste.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || paste.value === "") return;
  send({ target: selected, kind: "text", text: paste.value });
  paste.value = "";
});
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
