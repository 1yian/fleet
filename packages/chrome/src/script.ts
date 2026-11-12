export const BINDING = "__fleetPw";
export const RESCAN = "r";
const FLAG = "__fleetGuard";

export const ADOPT_ROOT = `function () { globalThis[${JSON.stringify(FLAG)}]?.adopt(this); }`;

export const PAGE_SCRIPT = `(() => {
  const flag = ${JSON.stringify(FLAG)};
  const live = globalThis[flag];
  if (live) {
    live.force();
    return;
  }
  const seen = new Set();
  const engaged = new Set();
  const hosts = new Map();
  let reported = "0";
  const FIELD_EVENTS = ["pointerdown", "keydown", "input", "change", "focusin", "focusout"];
  const isPassword = (node) => node instanceof HTMLInputElement && node.type === "password";
  const rootOf = (node) => hosts.get(node) || node.shadowRoot;
  const focused = () => {
    let node = document.activeElement;
    for (let root = node && rootOf(node); root && root.activeElement; root = rootOf(node)) node = root.activeElement;
    return node;
  };
  const scopes = () => {
    for (const host of [...hosts.keys()]) if (!host.isConnected) hosts.delete(host);
    return [document, ...hosts.values()];
  };
  const typed = () => {
    const active = focused();
    for (const node of engaged) {
      if (!node.isConnected) engaged.delete(node);
      else if (node === active) return true;
    }
    for (const scope of scopes()) {
      for (const node of scope.querySelectorAll("input[type=password]")) {
        if (node.value.length > 0) return true;
      }
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
    const root = event.currentTarget;
    if (root instanceof ShadowRoot) hosts.set(root.host, root);
    const node = event.composedPath()[0];
    if (node instanceof HTMLInputElement && (isPassword(node) || seen.has(node))) {
      seen.add(node);
      if (event.isTrusted && ["pointerdown", "keydown", "input"].includes(event.type)) engaged.add(node);
      if (event.type === "focusout" && node.value.length === 0) engaged.delete(node);
    }
    refresh();
  };
  const register = (root) => {
    hosts.set(root.host, root);
    for (const name of FIELD_EVENTS) root.addEventListener(name, touched, true);
  };
  const walk = (parent) => {
    for (const element of parent.querySelectorAll("*")) {
      const root = element.shadowRoot;
      if (!root) continue;
      register(root);
      walk(root);
    }
  };
  const rescan = () => {
    const bind = globalThis[${JSON.stringify(BINDING)}];
    if (typeof bind === "function") bind(${JSON.stringify(RESCAN)});
  };
  Element.prototype.attachShadow = new Proxy(Element.prototype.attachShadow, {
    apply(target, self, args) {
      const root = Reflect.apply(target, self, args);
      register(root);
      return root;
    },
  });
  for (const owner of [Element.prototype, ShadowRoot.prototype]) {
    if (typeof owner.setHTMLUnsafe !== "function") continue;
    owner.setHTMLUnsafe = new Proxy(owner.setHTMLUnsafe, {
      apply(target, self, args) {
        const result = Reflect.apply(target, self, args);
        rescan();
        return result;
      },
    });
  }
  for (const name of [...FIELD_EVENTS, "pageshow", "visibilitychange"])
    addEventListener(name, touched, true);
  walk(document);
  addEventListener("DOMContentLoaded", () => {
    walk(document);
    refresh();
  });
  setInterval(refresh, 400);
  Object.defineProperty(globalThis, flag, {
    value: {
      force: () => {
        reported = "";
        refresh();
      },
      adopt: (root) => {
        if (!(root instanceof ShadowRoot)) return;
        register(root);
        walk(root);
        refresh();
      },
    },
  });
  refresh();
})()`;
