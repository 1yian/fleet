export type Glyph =
  "queued" | "later" | "working" | "review" | "mate" | "needs" | "merging" | "done" | "dropped";

const CENTER = 7;
const RADIUS = 3.2;

function pie(fraction: number) {
  const angle = fraction * 2 * Math.PI - Math.PI / 2;
  const x = CENTER + RADIUS * Math.cos(angle);
  const y = CENTER + RADIUS * Math.sin(angle);
  const large = fraction > 0.5 ? 1 : 0;
  return (
    <path
      d={`M7 7 L7 3.8 A${String(RADIUS)} ${String(RADIUS)} 0 ${String(large)} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`}
      fill="currentColor"
    />
  );
}

const RING = <circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.5" />;

function GlyphBody({ glyph }: { readonly glyph: Glyph }) {
  switch (glyph) {
    case "queued":
      return (
        <circle
          cx="7"
          cy="7"
          r="5.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="1.6 1.9"
        />
      );
    case "later":
      return (
        <>
          {RING}
          <path
            d="M7 4.2V7l1.9 1.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </>
      );
    case "working":
      return (
        <>
          {RING}
          {pie(0.5)}
        </>
      );
    case "review":
      return (
        <>
          {RING}
          {pie(0.75)}
        </>
      );
    case "mate":
      return (
        <>
          {RING}
          {pie(0.5)}
        </>
      );
    case "needs":
      return (
        <>
          {RING}
          {pie(0.82)}
        </>
      );
    case "merging":
      return (
        <>
          {RING}
          {pie(0.92)}
        </>
      );
    case "done":
      return (
        <>
          <circle cx="7" cy="7" r="6.4" fill="currentColor" />
          <path
            d="M4.3 7.2l1.8 1.8 3.6-3.8"
            fill="none"
            stroke="#fff"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "dropped":
      return (
        <>
          <circle cx="7" cy="7" r="6.4" fill="currentColor" />
          <path d="M5 5l4 4M9 5l-4 4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
        </>
      );
  }
}

export function StatusIcon({ glyph }: { readonly glyph: Glyph }) {
  return (
    <svg className={`status-icon si-${glyph}`} viewBox="0 0 14 14" aria-hidden="true">
      <GlyphBody glyph={glyph} />
    </svg>
  );
}

export function SpinnerIcon() {
  return (
    <svg className="glyph spinner" viewBox="0 0 14 14" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="4.6"
        fill="none"
        stroke="currentColor"
        strokeOpacity=".25"
        strokeWidth="1.6"
      />
      <path
        d="M7 2.4a4.6 4.6 0 0 1 4.6 4.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PrIcon() {
  return (
    <svg className="glyph" viewBox="0 0 14 14" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
        <circle cx="4" cy="3.3" r="1.5" />
        <circle cx="4" cy="10.7" r="1.5" />
        <circle cx="10" cy="10.7" r="1.5" />
        <path d="M4 4.8v4.4M10 9.2V6.2a2 2 0 0 0-2-2H6.4" />
        <path d="M7.6 2.7 6.2 4.2l1.4 1.4" />
      </g>
    </svg>
  );
}

export function ClockIcon() {
  return (
    <svg className="glyph" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M7 4.3V7l1.8 1.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PenIcon() {
  return (
    <svg className="glyph" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M9.6 2.6l1.8 1.8-6.3 6.3-2.4.6.6-2.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg className="glyph chevron" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M5 3.5 8.5 7 5 10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 14 14">
        <path d="M2.5 10.5 7 3l4.5 7.5z" />
      </svg>
    </span>
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
