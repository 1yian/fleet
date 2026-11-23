import { useEffect, useState } from "react";
import {
  ActedSchema,
  BoardSchema,
  check,
  ThreadSchema,
  type Board,
  type BoardAction,
  type LaterResult,
  type Thread,
} from "@fleet/protocol";

export const unreachable = (error: unknown): string =>
  `The board could not reach cardd: ${error instanceof Error ? error.message : String(error)}`;

const BOARD_DEADLINE_MS = 10_000;

export async function loadBoard(cancel: AbortSignal): Promise<Board> {
  const response = await fetch("/api/board", {
    signal: AbortSignal.any([cancel, AbortSignal.timeout(BOARD_DEADLINE_MS)]),
  });
  return check(BoardSchema, await response.json());
}

export async function loadThread(card: number): Promise<Thread> {
  return check(ThreadSchema, await (await fetch(`/api/card/${String(card)}`)).json());
}

export interface Acted {
  readonly error: string | undefined;
  readonly later: LaterResult | undefined;
}

const refused = (error: string): Acted => ({ error, later: undefined });

export async function act(action: BoardAction): Promise<Acted> {
  try {
    const response = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
    const body: unknown = await response.json();
    if (response.ok) return { error: undefined, later: check(ActedSchema, body).later };
    const error =
      typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    return refused(
      typeof error === "string" ? error : `cardd refused the action (${String(response.status)})`,
    );
  } catch (error) {
    return refused(unreachable(error));
  }
}

export function useChanges(onLost: () => void): number {
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    let socket: WebSocket | undefined;
    let stopped = false;
    const open = (): void => {
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/live`,
      );
      let established = false;
      socket.addEventListener("open", () => {
        established = true;
        setChanges((n) => n + 1);
      });
      socket.addEventListener("message", () => {
        setChanges((n) => n + 1);
      });
      socket.addEventListener("close", () => {
        if (stopped) return;
        if (established) {
          onLost();
          setChanges((n) => n + 1);
        }
        setTimeout(open, 1000);
      });
    };
    open();
    return () => {
      stopped = true;
      onLost();
      socket?.close();
    };
  }, [onLost]);
  return changes;
}
