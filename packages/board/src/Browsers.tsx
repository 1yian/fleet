import { useState } from "react";
import type { BrowserLane, BrowserState } from "@fleet/protocol";
import { browserHref, openHandoff, type useBrowserLanes } from "./browser-api.ts";
import { BrowserSurface } from "./BrowserSurface.tsx";
import { useBrowserViewer } from "./browser-session.ts";
import "./browsers.css";

type Feed = ReturnType<typeof useBrowserLanes>;

export function BrowserPage({ lane, ...feed }: Feed & { readonly lane: string | undefined }) {
  return lane === undefined ? (
    <BrowserDirectory {...feed} />
  ) : (
    <LaneBrowser key={lane} lane={lane} />
  );
}

export function BrowserBoardLinks({
  enabled,
  lanes,
  feed,
}: Feed & { readonly enabled: boolean | undefined }) {
  if (!enabled) return null;
  const requests =
    feed === "open" ? [...lanes.values()].filter((lane) => openHandoff(lane) !== undefined) : [];
  return (
    <nav className="browser-board-links" aria-label="Lane browsers">
      <a className="browser-link" href={browserHref()}>
        Browsers
      </a>
      {requests.map((lane) => (
        <a className="browser-request" key={lane.lane} href={browserHref(lane.lane)}>
          <strong>{lane.lane} needs you</strong>
          <span>{openHandoff(lane)}</span>
        </a>
      ))}
    </nav>
  );
}

function laneStatus(lane: BrowserLane): string {
  if (openHandoff(lane) !== undefined) return "Handoff requested";
  if (lane.credentialStep) return "Agent is signing in";
  if (lane.captchaStep) return "Agent is solving a captcha";
  if (lane.control.kind === "human") return "In human control";
  if (lane.status === "ready") return "Ready to watch";
  if (lane.status === "stopped") return "Starts when opened";
  if (lane.status === "failed") return "Browser unavailable";
  return "Starting browser";
}

function BrowserDirectory({ lanes, feed }: Feed) {
  const sorted = [...lanes.values()].sort(
    (a, b) =>
      Number(openHandoff(b) !== undefined) - Number(openHandoff(a) !== undefined) ||
      a.lane.localeCompare(b.lane),
  );
  return (
    <main className="board browser-page">
      <a className="browser-back" href="#">
        ‹ Board
      </a>
      <h1>Lane browsers</h1>
      <p className="muted">Watch an agent’s browser or take over when it needs your help.</p>
      {feed !== "open" || sorted.length === 0 ? (
        <p className="browser-panel" role="status">
          {feed === "offline"
            ? "Can’t reach the browser service."
            : feed === "connecting"
              ? "Connecting to browser service…"
              : "No lane browsers yet."}
        </p>
      ) : (
        <ul className="browser-lanes">
          {sorted.map((lane) => (
            <li key={lane.lane}>
              <a className="browser-panel browser-lane" href={browserHref(lane.lane)}>
                <strong>{lane.lane}</strong>
                <span className={openHandoff(lane) === undefined ? "muted" : "browser-needed"}>
                  {laneStatus(lane)}
                </span>
                {openHandoff(lane) === undefined ? null : <span>{openHandoff(lane)}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function viewerMode(state: BrowserState | undefined, offline: boolean | undefined): string {
  if (offline) return "Browser connection interrupted";
  if (state === undefined) return "Connecting…";
  if (state.viewer.controlling) return "You’re in control";
  if (state.snapshot.control.kind === "human") return "Watching · Someone else is in control";
  return "Watching · Read only";
}

function BrowserTabs({
  state,
  busy,
  select,
}: {
  readonly state: BrowserState;
  readonly busy: boolean;
  readonly select: (tab: string) => void;
}) {
  const [explain, setExplain] = useState(false);
  const driving = state.viewer.controlling;
  return (
    <div className="browser-tabs">
      <nav aria-label="Remote tabs">
        {state.snapshot.tabs.map((tab, index) => (
          <button
            type="button"
            key={tab.id}
            aria-current={tab.id === state.activeTab ? "true" : undefined}
            disabled={busy}
            onClick={() => {
              if (tab.id === state.activeTab) return;
              if (driving) select(tab.id);
              else setExplain(true);
            }}
          >
            {tab.title || `Tab ${String(index + 1)}`}
          </button>
        ))}
      </nav>
      {explain && !driving ? <p role="status">Take control to switch remote tabs.</p> : null}
    </div>
  );
}

function LaneBrowser({ lane }: { readonly lane: string }) {
  const { frame, status, command, input } = useBrowserViewer(lane);
  const { state, pending, notice, offline, fenced } = status;
  const owns = state?.viewer.controlling === true;
  const driving = owns && pending === undefined && fenced !== true;
  const canTake =
    state?.snapshot.status === "ready" &&
    state.activeTab !== null &&
    state.snapshot.control.kind === "agent" &&
    !state.snapshot.credentialStep &&
    !state.snapshot.captchaStep;
  const handoff = openHandoff(state?.snapshot);
  const visible = frame !== undefined && state?.activeTab === frame.meta.targetId;
  return (
    <main className="board browser-page">
      <a className="browser-back" href={browserHref()}>
        ‹ Browsers
      </a>
      <header className="browser-heading">
        <div>
          <h1>{lane} browser</h1>
          <p className="muted" role="status">
            {viewerMode(state, offline)}
          </p>
        </div>
        <button
          className="browser-action"
          type="button"
          disabled={pending !== undefined || (!owns && (!canTake || fenced === true))}
          onClick={() => {
            command(owns ? "done" : "take");
          }}
        >
          {pending === "take"
            ? "Taking control…"
            : pending === "done"
              ? "Returning control…"
              : owns
                ? "Done"
                : "Take control"}
        </button>
      </header>
      {handoff === undefined ? null : (
        <p className="browser-handoff">
          <strong>Agent needs you</strong>
          <span>{handoff}</span>
        </p>
      )}
      {notice === undefined ? null : (
        <p className="browser-feedback" role="status">
          {notice}
        </p>
      )}
      {state?.snapshot.credentialStep || state?.snapshot.captchaStep ? (
        <p className="browser-feedback" role="status">
          {laneStatus(state.snapshot)}. Take control when it’s ready.
        </p>
      ) : null}
      <section className="browser-stage" aria-label="Remote browser">
        {state === undefined ? null : (
          <BrowserTabs
            state={state}
            busy={pending !== undefined || fenced === true}
            select={(tab) => {
              command({ tab });
            }}
          />
        )}
        {visible ? (
          <BrowserSurface frame={frame} driving={driving} input={input} />
        ) : (
          <p className="browser-placeholder">
            {offline || state?.snapshot.status === "failed"
              ? "Live view unavailable."
              : "Waiting for the browser screen…"}
          </p>
        )}
      </section>
      <p className="browser-hint muted">
        {owns
          ? "Click the browser to send input. Press Shift + Esc to leave the screen, or Done to return control."
          : "Mouse and keyboard input stay on this device until you take control."}
      </p>
    </main>
  );
}
