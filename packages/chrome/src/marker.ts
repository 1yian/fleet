export const GUARD_HEADER = "x-fleet-guard";

export type Guarding = "guarded" | "unguarded" | "down";

export function headersNameTheGuard(headers: string): boolean {
  return headers.split(/\r?\n/).some((line) => line.toLowerCase().startsWith(`${GUARD_HEADER}:`));
}

export async function guardHere(port: number): Promise<Guarding> {
  try {
    const answer = await fetch(`http://127.0.0.1:${String(port)}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    await answer.body?.cancel();
    return answer.headers.has(GUARD_HEADER) ? "guarded" : "unguarded";
  } catch {
    return "down";
  }
}
