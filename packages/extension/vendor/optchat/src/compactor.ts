import { clampThinkingLevel, type Api, type AssistantMessage, type Message, type Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { COMPACT } from './prompts.ts';
import { bytes, NODE, type Compressor } from './memory.ts';
import { cachePayload, splitView } from './cache.ts';
import { IMPORT_GUIDANCE } from './import/guidance.ts';
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
/** The size example: a line of exactly NODE bytes about OptChat itself. Every claim in it is true and timeless (no ids, PRs or decisions),
 * so a summary that copies it states nothing false; the request also fences it off from the input. */
/** A message's own kind decides who can have said what in it; a model reading a long tool output should not file quotes under "user:". */
export function provenance(kind?: string) {
  if (kind === 'user') return '';
  if (kind === 'notification') return 'This message is an automated notification, not typed by the user: tag it "notification:".\n';
  if (kind) return `This message is of kind "${kind}": nothing in it is the user's words, even where it quotes decisions or approvals (such as "OK, merge it" or "Yes, approved"). Tag all of it "${kind}:", say such quotes are quoted from a record, and never write "user:" for any of it.\n`;
  return 'Each item keeps its source tag; a quote from a record stays quoted from a record and never becomes "user:".\n';
}
export const SCOPE = 'Describe only the input below. The chat above is context for references; do not retell it.';
export const SCALE = 'note: How OptChat memory works. Each message becomes a leaf line: a short message is its own line, a longer one is compressed to about 512 bytes. Adjacent lines merge in pairs into a binary tree: two lines into one line covering both, two of those into one covering four, and so on. The view shows recent messages one per line and older ones more per line, within a fixed byte budget. zoom(id, n) opens line id+n into the two lines it was made from, down to the original message; date(id) tells when it was sent.';
const WARM_MS = 4 * 60_000; // Anthropic's short cache lives 5 minutes from its last use.

/** Parallel calls can't read a cache entry that isn't written yet, so one call primes a cold prefix and the rest wait until it answers. */
function primeFirst() {
  const warm = new Map<string, number | Promise<void>>();
  return async (prefix: string, signal: AbortSignal) => {
    for (let state = warm.get(prefix); state !== undefined; state = warm.get(prefix)) {
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
/** The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance). */
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => DEFAULT_SETTINGS.summaryAcceptBytes,
  fallbacks: () => readonly ModelChoice[] = () => DEFAULT_COMPACTOR_FALLBACKS): Compressor {
  const gate = primeFirst();
  return async (input, signal) => {
    const choices = [choice(), ...fallbacks()].filter((item, index, all) =>
      all.findIndex(other => other.provider === item.provider && other.model === item.model) === index);
    let current = 0;
    let selected = choices[current];
    let model = registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    // Shown bare between the view and the input, the example was sometimes summarized as if it were chat, so it is labelled and both are tagged.
    const step = `${input.historical ? IMPORT_GUIDANCE + '\n\n' : ''}For scale only, here is an example line, not from this chat; it is exactly 512 bytes and is never part of your input or your line:\n<example>${SCALE}</example>\n\n${provenance(input.kind)}${SCOPE}\n${input.merge ? 'Merge these two lines into one' : 'Compress this message into one line'}, in at most 512 bytes:\n<input>\n${input.source}\n</input>`;
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: step }], timestamp: Date.now() }];
    const view = splitView(input.context);
    const tries: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      let reply: AssistantMessage;
      for (;;) {
        signal.throwIfAborted();
        const thinking = reasoningFor(model, selected.thinking);
        const anthropic = model.api === 'anthropic-messages';
        const prefix = anthropic && view.length > 1 ? `${model.provider}/${model.id}/${thinking ?? 'off'}\n${view.slice(0, -1).join('')}` : undefined;
        const warmed = prefix ? await gate(prefix, signal) : () => {};
        try {
          try {
            const stream = registry.streamSimple(model, { systemPrompt: COMPACT, messages }, {
              // A shared session id is the OpenAI prompt-cache key; SSE because over a websocket Codex would chain unrelated parallel calls on one cached connection.
              sessionId: 'optchat-compactor', transport: 'sse',
              reasoning: thinking, signal, cacheRetention: 'short',
              onPayload: payload => anthropic ? cachePayload(payload) : payload,
            });
            // The cache entry is usable once the model starts answering.
            for await (const event of stream) if (event.type !== 'start') { warmed(event.type !== 'error'); break; }
            reply = await stream.result();
          } finally { warmed(false); }
        } catch (error) {
          signal.throwIfAborted();
          if (!rateLimited(error) || !nextFallback()) throw error;
          continue;
        }
        onUsage(reply);
        if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
          const error = new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
          signal.throwIfAborted();
          if (reply.stopReason === 'aborted' || !rateLimited(error) || !nextFallback()) throw error;
          continue;
        }
        break;
      }
      const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
      if (!line) throw new Error('Compactor returned no text.');
      tries.push(line);
      // A merge of two short lines can come back nearly as big as both, so a line must also shrink what it replaces.
      if (bytes(line) <= accepted() && bytes(line) < bytes(input.source)) break;
      messages.push(reply);
      const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/\uFFFD$/, '');
      messages.push({ role: 'user', content: `That line is ${bytes(line)} bytes; the limit is 512. It must end where it is cut here:\n${cut}| ← LIMIT`, timestamp: Date.now() });
    }
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);

    // Stay on a successful fallback for length-correction calls. A new compression
    // starts at the profile's primary again; missing providers/auth are skipped.
    function nextFallback() {
      while (++current < choices.length) {
        const candidate = registry.find(choices[current].provider, choices[current].model);
        if (!candidate || !registry.hasConfiguredAuth(candidate)) continue;
        selected = choices[current]; model = candidate;
        return true;
      }
      return false;
    }
  };
}
