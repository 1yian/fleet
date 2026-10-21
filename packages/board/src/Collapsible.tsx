import { useLayoutEffect, useRef, useState } from "react";

export function Collapsible({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || expanded) return;
    const measure = (): void => {
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [text, expanded]);
  return (
    <div className="collapsible">
      <div ref={box} className={expanded ? "body" : "body clamped"}>
        {text}
      </div>
      {overflows || expanded ? (
        <button
          type="button"
          className="more"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
