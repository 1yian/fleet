import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

const ADDRESS = /^#\/c-(\d+)$/;

const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener("hashchange", notify);
  return () => {
    window.removeEventListener("hashchange", notify);
  };
};
const hash = (): string => location.hash;

export function useCardRoute(): {
  readonly card: number | undefined;
  readonly open: (card: number) => void;
  readonly close: () => void;
} {
  const card = ADDRESS.exec(useSyncExternalStore(subscribe, hash))?.[1];
  const id = card === undefined ? undefined : Number(card);
  const scrolled = useRef(0);
  const fromBoard = useRef(false);

  const open = useCallback((next: number) => {
    scrolled.current = window.scrollY;
    fromBoard.current = true;
    location.hash = `/c-${String(next)}`;
  }, []);
  const close = useCallback(() => {
    if (!ADDRESS.test(location.hash)) return;
    if (fromBoard.current) {
      fromBoard.current = false;
      history.back();
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);

  useEffect(() => {
    window.scrollTo(0, id === undefined ? scrolled.current : 0);
  }, [id]);

  return { card: id, open, close };
}
