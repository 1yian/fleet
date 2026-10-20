// The board's link to cardd: the view, a card's thread, the captain's actions,
// and a live socket that says when cards.db changed.
import { useEffect, useState } from "react";
import {
  BoardSchema,
  check,
  ThreadSchema,
  type Board,
  type BoardAction,
  type Thread,
} from "@fleet/protocol";

/** The notice for a request that failed before cardd answered. */
export const unreachable = (error: unknown): string =>
  `The board could not reach cardd: ${error instanceof Error ? error.message : String(error)}`;

export async function loadBoard(): Promise<Board> {
  return check(BoardSchema, await (await fetch("/api/board")).json());
}

export async function loadThread(card: number): Promise<Thread> {
  return check(ThreadSchema, await (await fetch(`/api/card/${String(card)}`)).json());
}

/** Sends one action. Resolves with an error message when cardd refused it or could not be reached. */
export async function act(action: BoardAction): Promise<string | undefined> {
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    if (response.ok) return undefined;
    const body: unknown = await response.json();
    const error =
      typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    return typeof error === "string"
      ? error
      : `cardd refused the action (${String(response.status)})`;
  } catch (error) {
    return unreachable(error);
  }
}

/** A counter that goes up each time cards.db changes. Reconnects when the socket drops. */
export function useChanges(): number {
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    let socket: WebSocket | undefined;
    let stopped = false;
    const open = (): void => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`,
      );
      socket.addEventListener("open", () => {
        setChanges((n) => n + 1);
      });
      socket.addEventListener("message", () => {
        setChanges((n) => n + 1);
      });
      socket.addEventListener("close", () => {
        if (!stopped) setTimeout(open, 1000);
      });
    };
    open();
    return () => {
      stopped = true;
      socket?.close();
    };
  }, []);
  return changes;
}
