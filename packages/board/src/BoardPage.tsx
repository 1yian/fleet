import { Activity, useEffect, useSyncExternalStore } from "react";
import { Analytics } from "./Analytics.tsx";
import { App } from "./App.tsx";

const ANALYTICS = "#/analytics";
const VIEWS = [
  ["#/", "Board"],
  ["#/workers", "Active Workers"],
  [ANALYTICS, "Analytics"],
] as const;
const currentPage = (): string => location.hash;

function subscribe(notify: () => void): () => void {
  window.addEventListener("hashchange", notify);
  return () => {
    window.removeEventListener("hashchange", notify);
  };
}

export function BoardPage() {
  const hash = useSyncExternalStore(subscribe, currentPage);
  const analytics = hash === ANALYTICS;
  useEffect(() => {
    if (analytics) window.scrollTo(0, 0);
  }, [analytics]);
  const view = hash === "" ? "#/" : hash;
  return (
    <>
      {VIEWS.some(([href]) => href === view) ? (
        <nav className="analytics-nav" aria-label="Fleet views">
          {VIEWS.map(([href, label]) => (
            <a key={href} href={href} aria-current={href === view ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
      ) : null}
      <Activity mode={analytics ? "hidden" : "visible"}>
        <App />
      </Activity>
      {analytics ? <Analytics /> : null}
    </>
  );
}
