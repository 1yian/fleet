import { useEffect, useSyncExternalStore } from "react";
import { Analytics } from "./Analytics.tsx";
import { App } from "./App.tsx";

const ANALYTICS = "#/analytics";
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
  const showNav = analytics || hash === "" || hash === "#/";
  return (
    <>
      {showNav ? (
        <nav className="analytics-nav" aria-label="Fleet views">
          <a href="#/" aria-current={analytics ? undefined : "page"}>
            Board
          </a>
          <a href={ANALYTICS} aria-current={analytics ? "page" : undefined}>
            Analytics
          </a>
        </nav>
      ) : null}
      {analytics ? <Analytics /> : <App />}
    </>
  );
}
