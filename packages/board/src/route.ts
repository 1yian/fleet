// Which card is open. Each card has its own address: the board's URL plus #/c-21.
// Opening a card adds a history entry, so Back returns to the board where it was.
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
  // Where the board was scrolled to, and whether the board is the entry before this one.
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

  // A card opens at its top. The board comes back where the captain left it.
  useEffect(() => {
    window.scrollTo(0, id === undefined ? scrolled.current : 0);
  }, [id]);

  return { card: id, open, close };
}
