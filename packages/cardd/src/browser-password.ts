export const PASSWORD_WORLD = "fleet-password";

export const PASSWORD_CHECK = `function (count, remembered, suspected, ...nodes) {
  if (globalThis.__fleetPasswords === undefined) {
    const passwords = new WeakSet();
    const roots = new WeakSet();
    const shadows = new WeakMap();
    const password = (el) => el.localName === "input" && (el.type === "password" || /\\b(current|new)-password\\b/.test(el.autocomplete));
    const remember = (el) => { if (password(el)) passwords.add(el); };
    const scan = (root) => {
      watch(root);
      let held = false;
      for (const el of root.querySelectorAll("*")) {
        remember(el);
        if (passwords.has(el) && el.value !== "") held = true;
        const shadow = el.shadowRoot ?? shadows.get(el);
        if (shadow !== undefined && shadow !== null && scan(shadow)) held = true;
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
    globalThis.__fleetPasswords = { scan, shadows, passwords };
  }
  const tracker = globalThis.__fleetPasswords;
  for (let i = 0; i < count; i += 2) tracker.shadows.set(nodes[i], nodes[i + 1]);
  const fields = nodes.slice(count);
  for (const index of remembered) tracker.passwords.add(fields[index]);
  for (const index of suspected) {
    const field = fields[index];
    if (["text", "email", "tel", "url", "search", "number", "password"].includes(field.type)) tracker.passwords.add(field);
  }
  const held = tracker.scan(this);
  return { held, passwords: fields.flatMap((field, index) => tracker.passwords.has(field) ? [index] : []) };
}`;

export const PASSWORD_INIT = `(${PASSWORD_CHECK}).call(document, 0, [], []);`;
