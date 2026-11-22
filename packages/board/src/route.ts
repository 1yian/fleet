import { useCallback, useEffect, useSyncExternalStore } from "react";

const ADDRESS = /^#\/c-(\d+)$/;

const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener("hashchange", notify);
  return () => {
    window.removeEventListener("hashchange", notify);
  };
};
const hash = (): string => location.hash;

const positions = new Map<string, number>();
let current = "";
let where = "";

const fresh = (): string => `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;

function entry(): { readonly key: string | undefined; readonly opened: boolean } {
  const state: unknown = history.state;
  if (typeof state !== "object" || state === null) return { key: undefined, opened: false };
  const key = Reflect.get(state, "key");
  return {
    key: typeof key === "string" ? key : undefined,
    opened: Reflect.get(state, "opened") === true,
  };
}

function adopt(): string {
  const { key, opened } = entry();
  if (key !== undefined) return key;
  const next = fresh();
  history.replaceState({ key: next, opened }, "");
  return next;
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
    if (!ADDRESS.test(where)) positions.set(current, window.scrollY);
    current = fresh();
    where = `#/c-${String(next)}`;
    history.pushState({ key: current, opened: true }, "", `#/c-${String(next)}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);
  const close = useCallback(() => {
    if (!ADDRESS.test(location.hash)) return;
    if (entry().opened) {
      history.back();
      return;
    }
    current = fresh();
    where = "";
    history.replaceState({ key: current, opened: false }, "", location.pathname + location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);

  useEffect(() => {
    current = adopt();
    where = location.hash;
    history.scrollRestoration = "manual";
    const depart = (): void => {
      if (!ADDRESS.test(where)) positions.set(current, window.scrollY);
      current = adopt();
      where = location.hash;
    };
    window.addEventListener("popstate", depart);
    return () => {
      window.removeEventListener("popstate", depart);
      history.scrollRestoration = "auto";
    };
  }, []);

  useEffect(() => {
    window.scrollTo(0, positions.get(current) ?? 0);
  }, [address]);

  return { card: id, workers, open, close };
}
