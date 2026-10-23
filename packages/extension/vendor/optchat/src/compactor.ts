import { setTimeout as sleep } from 'node:timers/promises';
import { clampThinkingLevel, isRetryableAssistantError, type Api, type AssistantMessage, type Message, type Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { COMPACT, compaction, IMPORT_GUIDANCE, tooLong } from './prompts.ts';
import { bytes, cut, Refused, type Compressor } from './memory.ts';
import { cachePayload, splitView } from './cache.ts';
import { DEFAULT_SETTINGS } from './settings.ts';

export interface ModelChoice { provider: string; model: string; thinking: ThinkingLevel }
export const DEFAULT_COMPACTOR_FALLBACKS: readonly ModelChoice[] = [
  { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'low' },
  // Use Sonnet for the Vertex summary tier, even when the primary is Haiku.
  { provider: 'vertex-claude', model: 'claude-sonnet-5-5', thinking: 'low' },
];
function rateLimited(error: unknown) {
  const status = error && typeof error === 'object' ? (error as { status?: number; statusCode?: number }) : undefined;
  return status?.status === 429 || status?.statusCode === 429 ||
    /\b429\b|\brate[_ -]?limit(?:ed|_error)?\b|\boverloaded(?:_error)?\b|\btoo many requests\b/i.test(error instanceof Error ? error.message : String(error));
}
/** A level the model can't take would be sent as no level, which Sonnet 5.5 runs at high effort; Pi's own sessions clamp the same way. */
export const reasoningFor = (model: Model<Api>, level: ThinkingLevel) => {
  const thinking = clampThinkingLevel(model, level);
  return thinking === 'off' ? undefined : thinking;
};
const WARM_MS = 4 * 60_000; // Anthropic's short cache lives 5 minutes from its last use.

/** Parallel calls can't read a cache entry that isn't written yet, so one call primes a cold prefix and the rest wait until it answers.
 * Parallel compactions end their views at different messages, so a call also waits for a primer of a shorter prefix of its own view. */
function primeFirst() {
  const warm = new Map<string, number | Promise<void>>();
  return async (prefix: string, signal: AbortSignal) => {
    const priming = () => { for (const [k, state] of warm) if (typeof state !== 'number' && prefix.startsWith(k)) return state; };
    for (let state = warm.get(prefix) ?? priming(); state !== undefined; state = warm.get(prefix) ?? priming()) {
      if (typeof state === 'number') { if (Date.now() - state < WARM_MS) break; warm.delete(prefix); continue; }
      // A cancelled waiter leaves at once instead of waiting for someone else's primer.
      signal.throwIfAborted();
      let wake = () => {};
      const aborted = new Promise<void>(resolve => { wake = resolve; });
      signal.addEventListener('abort', wake, { once: true });
      await Promise.race([state, aborted]);
      signal.removeEventListener('abort', wake);
      signal.throwIfAborted();
    }
    let release = () => {};
    const pending = warm.has(prefix) ? undefined : new Promise<void>(resolve => { release = resolve; });
    if (pending) warm.set(prefix, pending);
    return (ok: boolean) => {
      if (ok) { for (const [k, at] of warm) if (typeof at === 'number' && Date.now() - at >= WARM_MS) warm.delete(k); warm.set(prefix, Date.now()); }
      else if (warm.get(prefix) === pending) warm.delete(prefix);
      release();
    };
  };
}
/** Pi's agent loop retries a dropped connection itself; streamSimple doesn't, so a transient error is asked again before it surfaces. */
export async function retryTransient(ask: () => Promise<AssistantMessage>, onReply: (reply: AssistantMessage) => void,
  delays: readonly number[] = [1000, 2000], signal?: AbortSignal, giveUp: (reply: AssistantMessage) => boolean = () => false) {
  for (let retry = 0; ; retry++) {
    const reply = await ask();
    onReply(reply);
    if (retry >= delays.length || !isRetryableAssistantError(reply) || giveUp(reply)) return reply;
    await sleep(delays[retry], undefined, { signal });
  }
}

/** The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance). */
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => DEFAULT_SETTINGS.summaryAcceptBytes,
  retryDelays?: readonly number[], fallbacks: () => readonly ModelChoice[] = () => DEFAULT_COMPACTOR_FALLBACKS): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const choices = [choice(), ...fallbacks()].filter((item, index, all) =>
      all.findIndex(other => other.provider === item.provider && other.model === item.model) === index);
    let current = 0;
    let selected = choices[current];
    const primary = registry.find(selected.provider, selected.model);
    if (!primary) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    let model = primary;
    const step = `${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}${compaction(input)}`;
    // OpenAI joins text blocks with nothing between them, so the task starts its own paragraph after the view.
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: `\n\n${step}` }], timestamp: Date.now() }];
    const view = splitView(input.context);
    const tries: string[] = [];
    const ask = async () => {
      const thinking = reasoningFor(model, selected.thinking);
      const anthropic = model.api === 'anthropic-messages';
      const prefix = anthropic && view.length > 1 ? `${model.provider}/${model.id}/${thinking ?? 'off'}\n${view.slice(0, -1).join('')}` : undefined;
      const warmed = prefix ? await gate(prefix, signal) : () => {};
      try {
        const stream = registry.streamSimple(model, { systemPrompt: COMPACT, messages }, {
          // A shared session id is the OpenAI prompt-cache key; SSE because over a websocket Codex would chain unrelated parallel calls on one cached connection.
          sessionId: 'optchat-compactor', transport: 'sse',
          reasoning: thinking, signal, cacheRetention: 'short',
          onPayload: payload => anthropic ? cachePayload(payload, { end: false }) : payload,
        });
        // The cache entry is usable once the model starts answering.
        for await (const event of stream) if (event.type !== 'start') { warmed(event.type !== 'error'); break; }
        return await stream.result();
      } finally { warmed(false); }
    };
    // Stay on a successful fallback for length-correction calls. A new compression
    // starts at the profile's primary again; missing providers/auth are skipped.
    const usableFallback = () => {
      for (let at = current + 1; at < choices.length; at++) {
        const candidate = registry.find(choices[at].provider, choices[at].model);
        if (candidate && registry.hasConfiguredAuth(candidate)) return { at, candidate };
      }
      return undefined;
    };
    const nextFallback = () => {
      const next = usableFallback();
      if (!next) return false;
      current = next.at; selected = choices[next.at]; model = next.candidate;
      return true;
    };
    const rateLimitedReply = (reply: AssistantMessage) => reply.stopReason === 'error' && rateLimited(new Error(reply.errorMessage ?? ''));
    const answer = async () => {
      for (;;) {
        signal.throwIfAborted();
        try {
          const reply = await retryTransient(ask, onUsage, retryDelays, signal, failed => rateLimitedReply(failed) && usableFallback() !== undefined);
          if (rateLimitedReply(reply) && nextFallback()) continue;
          return reply;
        } catch (error) {
          signal.throwIfAborted();
          if (!rateLimited(error) || !nextFallback()) throw error;
        }
      }
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await answer();
      // A stop reason means the model answered: a refusal or a content filter, which asking again repeats.
      // A provider's own 'error' stop (Mistral) is a failure on its side, not an answer: a plain error, tried again later.
      if (reply.stopReason === 'error' && reply.rawStopReason !== undefined && reply.rawStopReason !== 'error' && !isRetryableAssistantError(reply))
        throw new Refused(reply.errorMessage ?? `Compactor stopped: ${reply.rawStopReason}`);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
      // A reply cut off at the token limit, or one that calls a tool, is no summary: ask again.
      if (reply.stopReason === 'length' || reply.content.some(c => c.type === 'toolCall')) continue;
      // The compactions' view shows each line under its id+n| head, which a line can copy.
      const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
      if (!line) throw new Refused('Compactor returned no text.');
      tries.push(line);
      // A merge of two short lines can come back nearly as big as both, so a line must also shrink what it replaces.
      if (bytes(line) <= accepted() && bytes(line) < bytes(input.source)) break;
      messages.push(reply);
      messages.push({ role: 'user', content: tooLong(bytes(line), cut(line)), timestamp: Date.now() });
    }
    if (!tries.length) throw new Refused('Compactor returned no whole line in 5 tries.');
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
  };
}
