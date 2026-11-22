import { useEffect, useState, type ReactNode } from "react";
import { AnalyticsSchema, check, type Analytics as Data } from "@fleet/protocol";
import "./analytics.css";

type Tokens = Data["lanes"][number]["tokens"];
const number = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat("en", { timeZone: "UTC", month: "short", day: "numeric" });
const hour = new Intl.DateTimeFormat("en", { timeZone: "UTC", hour: "2-digit", hourCycle: "h23" });
const time = new Intl.DateTimeFormat("en", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const HOUR = 3_600_000;
const HIGHLIGHTS = [
  ["input", "Input"],
  ["cached", "Cached input"],
  ["output", "Output"],
] as const;

const total = (tokens: Tokens | null): number =>
  tokens === null ? 0 : tokens.input + tokens.cached + tokens.output;

const tokenLabel = (tokens: Tokens): string =>
  HIGHLIGHTS.map(([key, label]) => `${label}: ${number.format(tokens[key])}`).join(" · ");

function Stack({
  tokens,
  max,
  axis,
}: {
  readonly tokens: Tokens;
  readonly max: number;
  readonly axis: "height" | "width";
}) {
  return HIGHLIGHTS.map(([key]) => (
    <span
      key={key}
      className={`analytics-${key}`}
      style={{ [axis]: `${(100 * tokens[key]) / max}%` }}
    />
  ));
}

function scale(peak: number): number {
  if (peak < 3) return 3;
  const power = 10 ** Math.floor(Math.log10(peak / 3));
  return Math.ceil(peak / (3 * power)) * 3 * power;
}

function spanLabel(at: number, from: number, to: number): string {
  const start = Math.max(at, from);
  const end = Math.min(at + HOUR, to);
  const partial = end < at + HOUR || start > at;
  return `${date.format(at)}, ${time.format(start)} to ${time.format(end)} UTC${partial ? " (partial)" : ""}`;
}

function hourLabels(hours: Data["hours"]) {
  return hours.map(({ at }, i) => {
    const label = hour.format(at);
    return (
      <span key={at} className={i % 6 === 0 ? undefined : "analytics-tick-minor"}>
        {i % 3 === 0 ? label : ""}
      </span>
    );
  });
}

type Interaction = { readonly kind: "hover" | "focus" | "tap"; readonly at: number };

function Hourly({ data }: { readonly data: Data }) {
  const [interactions, setInteractions] = useState<readonly Interaction[]>([]);
  const begin = (kind: Interaction["kind"], at: number): void => {
    setInteractions((all) => [...all.filter((one) => one.kind !== kind), { kind, at }]);
  };
  const end = (kind: Interaction["kind"]): void => {
    setInteractions((all) => all.filter((one) => one.kind !== kind));
  };
  const active = interactions.at(-1)?.at;
  const selected = data.hours.find(({ at }) => at === active);
  const max = scale(Math.max(...data.hours.map(({ tokens }) => total(tokens))));
  const sum = data.hours.reduce((count, { tokens }) => count + total(tokens), 0);
  const sampled = data.hours.some(({ tokens }) => tokens !== null);
  const grid = { gridTemplateColumns: `repeat(${data.hours.length}, minmax(0, 1fr))` };

  return (
    <section className="analytics-panel analytics-hourly" aria-labelledby="analytics-hourly">
      <div className="analytics-panel-head">
        <div>
          <h2 id="analytics-hourly">Tokens used by hour</h2>
          <p>Last 24 hours · UTC</p>
        </div>
        <div className="analytics-total">
          <strong>{sampled ? number.format(sum) : "No samples"}</strong>
          <span>recorded tokens</span>
        </div>
      </div>
      <div className="analytics-legend">
        {HIGHLIGHTS.map(([key, label]) => (
          <span key={key}>
            <i className={`analytics-${key}`} />
            {label}
          </span>
        ))}
        <span>
          <i className="analytics-zero" />
          Measured zero
        </span>
        <span>
          <i className="analytics-missing" />
          No records
        </span>
      </div>
      <div className="analytics-inspector" aria-live="polite">
        {selected === undefined ? (
          <span>Hover or focus an hour for its breakdown.</span>
        ) : (
          <>
            <strong>{spanLabel(selected.at, data.from, data.to)}</strong>
            <span>
              {selected.tokens === null
                ? "No usage records"
                : `${number.format(total(selected.tokens))} tokens · ${tokenLabel(selected.tokens)}`}
            </span>
          </>
        )}
      </div>
      <div className="analytics-plot">
        <div className="analytics-y" aria-hidden="true">
          {[max, (max * 2) / 3, max / 3, 0].map((n) => (
            <span key={n}>{compact.format(n)}</span>
          ))}
        </div>
        <div className="analytics-columns" style={grid}>
          {data.hours.map(({ at, tokens }) => (
            <button
              key={at}
              type="button"
              aria-label={`${spanLabel(at, data.from, data.to)}: ${
                tokens === null
                  ? "No usage records"
                  : `${number.format(total(tokens))} tokens · ${tokenLabel(tokens)}`
              }`}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") begin("hover", at);
              }}
              onPointerLeave={() => {
                end("hover");
              }}
              onPointerUp={(event) => {
                if (event.pointerType === "touch") begin("tap", at);
              }}
              onFocus={() => {
                begin("focus", at);
              }}
              onBlur={() => {
                end("focus");
              }}
            >
              {tokens === null || total(tokens) === 0 ? (
                <span className={tokens === null ? "analytics-missing" : "analytics-zero"} />
              ) : (
                <Stack tokens={tokens} max={max} axis="height" />
              )}
            </button>
          ))}
        </div>
        <div className="analytics-x" style={grid} aria-hidden="true">
          {hourLabels(data.hours)}
        </div>
      </div>
      <p className="analytics-note">
        Mate usage from local OptChat ledgers only. Input includes cache writes; cached input counts
        reads only. No records does not mean zero usage.
      </p>
    </section>
  );
}

function Lanes({ lanes }: { readonly lanes: Data["lanes"] }) {
  const ranked = lanes.toSorted((a, b) => total(b.tokens) - total(a.tokens));
  const max = Math.max(1, ...ranked.map(({ tokens }) => total(tokens)));
  return (
    <section className="analytics-panel" aria-labelledby="analytics-lanes">
      <div className="analytics-panel-head">
        <div>
          <h2 id="analytics-lanes">Tokens by lane</h2>
          <p>Last 24 hours · Same recorded usage</p>
        </div>
      </div>
      {ranked.length === 0 ? (
        <p className="analytics-note">No lane usage records in this window.</p>
      ) : (
        <ul className="analytics-lanes">
          {ranked.map(({ lane, tokens }) => (
            <li key={lane}>
              <div className="analytics-lane-head">
                <strong>{lane}</strong>
                <strong>{number.format(total(tokens))}</strong>
              </div>
              <div className="analytics-lane-track" aria-hidden="true">
                <Stack tokens={tokens} max={max} axis="width" />
              </div>
              <div className="analytics-lane-values">{tokenLabel(tokens)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Closures({ days }: { readonly days: Data["closures"] }) {
  const max = Math.max(1, ...days.map(({ count }) => count));
  return (
    <section className="analytics-panel" aria-labelledby="analytics-closures">
      <div className="analytics-panel-head">
        <div>
          <h2 id="analytics-closures">Cards closed as done</h2>
          <p>Last 7 calendar days · UTC</p>
        </div>
        <div className="analytics-total">
          <strong>{number.format(days.reduce((sum, day) => sum + day.count, 0))}</strong>
          <span>cards closed</span>
        </div>
      </div>
      <ul className="analytics-days">
        {days.map(({ at, count }, i) => (
          <li key={at}>
            <div className="analytics-day-track">
              <span
                style={{ height: `${(100 * count) / max}%` }}
                className={count === 0 ? "analytics-day-zero" : undefined}
              >
                <strong>{number.format(count)}</strong>
              </span>
            </div>
            <span>{i === days.length - 1 ? "Today" : date.format(at)}</span>
          </li>
        ))}
      </ul>
      <p className="analytics-note">
        Successful closes recorded by cardd. Dropped cards are excluded.
      </p>
    </section>
  );
}

function useAnalytics(): Data | Error | undefined {
  const [result, setResult] = useState<Data | Error>();
  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/analytics", { signal: controller.signal });
        if (!response.ok) throw new Error("Could not load analytics from cardd.");
        const data = check(AnalyticsSchema, await response.json());
        if (!controller.signal.aborted) setResult(data);
      } catch {
        if (!controller.signal.aborted)
          setResult(new Error("Could not load analytics from cardd."));
      }
    };
    void load();
    return () => {
      controller.abort();
    };
  }, []);
  return result;
}

export function Analytics() {
  const data = useAnalytics();
  let body: ReactNode;
  if (data === undefined) body = <p role="status">Loading analytics…</p>;
  else if (data instanceof Error) body = <p role="alert">{data.message}</p>;
  else
    body = (
      <>
        <Hourly data={data} />
        <div className="analytics-secondary">
          <Lanes lanes={data.lanes} />
          <Closures days={data.closures} />
        </div>
      </>
    );
  return (
    <main className="analytics">
      <header>
        <h1>Analytics</h1>
        <p>Model usage and completed work across the fleet.</p>
      </header>
      {body}
    </main>
  );
}
