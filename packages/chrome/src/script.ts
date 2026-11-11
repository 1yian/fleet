export const BINDING = "__fleetPw";

export const PAGE_SCRIPT = `(() => {
  const flag = "__fleetGuard";
  const live = globalThis[flag];
  if (live) {
    live.force();
    return;
  }
  const seen = new Set();
  const engaged = new Set();
  let reported = "0";
  const isPassword = (node) => node instanceof HTMLInputElement && node.type === "password";
  const focused = () => {
    let node = document.activeElement;
    while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
    return node;
  };
  const typed = () => {
    const active = focused();
    for (const node of engaged) {
      if (!node.isConnected) engaged.delete(node);
      else if (node === active) return true;
    }
    for (const node of document.querySelectorAll("input[type=password]")) {
      if (node.value.length > 0) return true;
    }
    for (const node of seen) {
      if (!node.isConnected) seen.delete(node);
      else if (node.value.length > 0) return true;
    }
    return false;
  };
  const refresh = () => {
    const next = typed() ? "1" : "0";
    if (next === reported) return;
    reported = next;
    const bind = globalThis[${JSON.stringify(BINDING)}];
    if (typeof bind === "function") bind(next);
  };
  const touched = (event) => {
    const node = event.composedPath()[0];
    if (node instanceof HTMLInputElement && (isPassword(node) || seen.has(node))) {
      seen.add(node);
      if (event.isTrusted && ["pointerdown", "keydown", "input"].includes(event.type)) engaged.add(node);
      if (event.type === "focusout" && node.value.length === 0) engaged.delete(node);
    }
    refresh();
  };
  for (const name of ["pointerdown", "keydown", "input", "change", "focusin", "focusout", "pageshow", "visibilitychange"])
    addEventListener(name, touched, true);
  setInterval(refresh, 400);
  Object.defineProperty(globalThis, flag, {
    value: {
      force: () => {
        reported = "";
        refresh();
      },
    },
  });
  refresh();
})()`;
