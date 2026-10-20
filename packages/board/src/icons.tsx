// Small inline icons. Each is decorative: the text next to it carries the meaning.
import type { Tone } from "./format.ts";

export function Sparkle() {
  return (
    <svg className="sparkle" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M7 1.5 8.4 5.6 12.5 7 8.4 8.4 7 12.5 5.6 8.4 1.5 7 5.6 5.6Z" />
      <circle cx="13" cy="13" r="1.4" />
    </svg>
  );
}

/** A warning for the captain, a spinner while work runs, a ring while it waits, and a dot when it ended. */
export function StatusIcon({ tone, active }: { readonly tone: Tone; readonly active: boolean }) {
  if (tone === "needs")
    return (
      <svg className="status-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 2 15 14H1Z" />
      </svg>
    );
  if (tone === "running")
    return <span className={`status-icon ${active ? "spinner" : "ring"}`} aria-hidden="true" />;
  return <span className="status-icon dot" aria-hidden="true" />;
}

export function BoardIcon() {
  return (
    <svg className="view-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2.5" width="4" height="11" rx="1.2" />
      <rect x="10" y="2.5" width="4" height="7" rx="1.2" />
    </svg>
  );
}

export function ListIcon() {
  return (
    <svg className="view-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

export function PencilIcon() {
  return (
    <svg className="inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 2.5 13.5 5.5 5.5 13.5 2 14 2.5 10.5Z" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg className="inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10 3 5 8l5 5" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg className="inline-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  );
}
