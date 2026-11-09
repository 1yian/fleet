import { PASSWORD_INIT } from "./browser-password.ts";

export const initScript = (label: string): string => `${PASSWORD_INIT}
(() => {
  const label = ${JSON.stringify(label)};
  const fold = (url) => {
    try {
      location.assign(new URL(String(url), location.href).href);
    } catch {
      return null;
    }
    return window;
  };
  Object.defineProperty(window, "open", { value: fold, configurable: true, writable: true });
  const self = (event) => {
    const node = event.target instanceof Element ? event.target.closest("[target]") : null;
    if (node !== null && node.getAttribute("target") !== "_self") node.setAttribute("target", "_self");
  };
  document.addEventListener("click", self, true);
  document.addEventListener("submit", self, true);
  if (window !== window.top) return;
  const mark = () => {
    if (!document.title.startsWith(label)) document.title = document.title === "" ? label : label + " - " + document.title;
  };
  document.addEventListener("DOMContentLoaded", () => {
    mark();
    new MutationObserver(mark).observe(document.head, { subtree: true, childList: true, characterData: true });
  });
  mark();
})();`;
