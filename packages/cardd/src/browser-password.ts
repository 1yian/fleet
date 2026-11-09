export const PASSWORD_INIT = `(() => {
  if (typeof window.__fleetPasswordHeld === "function") return;
  const passwords = new WeakSet();
  const roots = new WeakSet();
  const password = (el) => el.localName === "input" && (el.type === "password" || /\\b(current|new)-password\\b/.test(el.autocomplete));
  const remember = (el) => { if (password(el)) passwords.add(el); };
  const scan = (root) => {
    watch(root);
    let held = false;
    for (const el of root.querySelectorAll("*")) {
      remember(el);
      if (passwords.has(el) && el.value !== "") held = true;
      if (el.shadowRoot !== null && scan(el.shadowRoot)) held = true;
      if (el.localName === "iframe" || el.localName === "frame") {
        try {
          const child = el.contentWindow;
          if (typeof child?.__fleetPasswordHeld === "function" ? child.__fleetPasswordHeld() : el.contentDocument !== null && scan(el.contentDocument)) held = true;
        } catch { }
      }
    }
    return held;
  };
  const watch = (root) => {
    if (roots.has(root)) return;
    roots.add(root);
    root.addEventListener("input", (event) => {
      for (const el of event.composedPath()) remember(el);
    }, true);
    new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.attributeName === "type" && change.oldValue?.toLowerCase() === "password") passwords.add(change.target);
        if (change.attributeName === "autocomplete" && /\\b(current|new)-password\\b/.test(change.oldValue ?? "")) passwords.add(change.target);
      }
      scan(root);
    }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["type", "autocomplete"], attributeOldValue: true });
  };
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    const root = attach.call(this, options);
    watch(root);
    return root;
  };
  window.__fleetPasswordHeld = () => scan(document);
  scan(document);
})();`;

export const PASSWORD_ENTERED = `function () {
  return window.__fleetPasswordHeld();
}`;
