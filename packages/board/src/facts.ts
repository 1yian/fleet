import { useEffect, useRef, useState } from "react";
import type { BoardCard } from "@fleet/protocol";
import { loadThread } from "./api.ts";
import { factsOf, needsFacts, startOfDay, type Facts } from "./format.ts";

interface Known {
  readonly revision: number;
  readonly facts: Facts;
}

export function useFacts(
  cards: readonly BoardCard[] | undefined,
  now: number,
): ReadonlyMap<number, Facts> {
  const [known, setKnown] = useState<ReadonlyMap<number, Known>>(new Map());
  const asked = useRef(new Set<string>());
  const today = startOfDay(now);
  useEffect(() => {
    for (const card of cards ?? []) {
      const key = `${String(card.id)}:${String(card.revision)}`;
      if (!needsFacts(card, today) || asked.current.has(key)) continue;
      asked.current.add(key);
      loadThread(card.id).then(
        (thread) => {
          setKnown((all) =>
            new Map(all).set(card.id, { revision: card.revision, facts: factsOf(thread.entries) }),
          );
        },
        () => {
          asked.current.delete(key);
        },
      );
    }
  }, [cards, today]);
  return new Map([...known].map(([id, each]) => [id, each.facts]));
}
