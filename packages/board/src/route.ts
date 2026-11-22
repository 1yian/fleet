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
  readonly workers: boolean;
  readonly open: (card: number) => void;
  readonly close: () => void;
} {
  const address = useSyncExternalStore(subscribe, hash);
  const workers = address === "#/workers";
  const card = ADDRESS.exec(address)?.[1];
  const id = card === undefined ? undefined : Number(card);
  const origin = useRef<{ from: string; to: string; scroll: number } | undefined>(undefined);

  const open = useCallback((next: number) => {
    const to = `#/c-${String(next)}`;
    origin.current = { from: location.hash, to, scroll: window.scrollY };
    location.hash = to;
  }, []);
  const close = useCallback(() => {
    if (!ADDRESS.test(location.hash)) return;
    if (origin.current?.to === location.hash) {
      history.back();
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);

  useEffect(() => {
    const previous = origin.current;
    window.scrollTo(0, previous?.from === address ? previous.scroll : 0);
    if (previous?.to !== address && previous?.from !== address) origin.current = undefined;
  }, [address]);

  return { card: id, workers, open, close };
}
