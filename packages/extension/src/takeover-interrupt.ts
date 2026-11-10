const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface Interruption {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

export function interruption(): Interruption {
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort();
  };
  for (const name of SIGNALS) process.on(name, interrupt);
  return {
    signal: controller.signal,
    release: () => {
      for (const name of SIGNALS) process.off(name, interrupt);
    },
  };
}

export function whenAborted(signal: AbortSignal, act: () => void): () => void {
  if (signal.aborted) act();
  else signal.addEventListener("abort", act, { once: true });
  return () => {
    signal.removeEventListener("abort", act);
  };
}
