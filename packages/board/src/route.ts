import { useCallback, useEffect, useSyncExternalStore } from "react";

const ADDRESS = /^#\/c-(\d+)$/;

const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener("hashchange", notify);
  return () => {
    window.removeEventListener("hashchange", notify);
  };
};
const hash = (): string => location.hash;

function entry(): { readonly opened: boolean; readonly scroll: number } {
  const state: unknown = history.state;
  const opened =
    typeof state === "object" && state !== null && Reflect.get(state, "opened") === true;
  const scroll = typeof state === "object" && state !== null ? Reflect.get(state, "scroll") : 0;
  return { opened, scroll: typeof scroll === "number" ? scroll : 0 };
}

export function useCardRoute(): {
  readonly card: number | undefined;
  readonly workers: boolean;
  readonly open: (card: number) => void;
  readonly close: () => void;
} {
  const address = useSyncExternalStore(subscribe, hash);
  const workers = address === "#/workers";
  const card = ADDRESS.exec(address)?.[1];
  const id = card === undefined ? undefined : Number(card);
  const open = useCallback((next: number) => {
    history.pushState({ opened: true }, "", `#/c-${String(next)}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);
  const close = useCallback(() => {
    if (!ADDRESS.test(location.hash)) return;
    if (entry().opened) {
      history.back();
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);

  useEffect(() => {
    history.scrollRestoration = "manual";
    let frame = 0;
    const save = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        history.replaceState({ opened: entry().opened, scroll: window.scrollY }, "");
      });
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      window.removeEventListener("scroll", save);
      cancelAnimationFrame(frame);
      history.scrollRestoration = "auto";
    };
  }, []);

  useEffect(() => {
    window.scrollTo(0, entry().scroll);
  }, [address]);

  return { card: id, workers, open, close };
}
