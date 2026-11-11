import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import { TiersAccountsSchema } from "@fleet/protocol";
import { readTiersConfig } from "./tiers-config.ts";

const PROVIDER = "fleet";
const MODEL_ID = "pinned";
const COOLED_ENTRY = "fleet-account-cooled";
const MOVED_ENTRY = "fleet-account-moved";
const RATE_SECONDS = 600;
const QUOTA_SECONDS = 3600;
const MS = 1000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const OUT_OF_QUOTA =
  /quota|credit balance|insufficient (funds|credits)|billing|payment required|\b402\b|exceeded your current|usage limit/i;
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;

const REASONS = ["throttled", "out of quota"] as const;
const Reason = Type.Enum(REASONS);
type Reason = Static<typeof Reason>;
const BLOCKED_UNTIL = new RegExp(`\\((?:${REASONS.join("|")}) until (\\S+?)\\)`, "g");

const CooledSchema = Type.Object({
  provider: Type.String(),
  reason: Reason,
  untilMs: Type.Number(),
});
type Cooled = Static<typeof CooledSchema>;

const PinSchema = Type.Object({ model: Type.String(), accounts: Type.Array(Type.String()) });
type Pin = Static<typeof PinSchema>;

type Verdict =
  | { readonly provider: string; readonly usable: ModelRoute["model"] }
  | { readonly provider: string; readonly blocked: string };

function accountGroup(provider: string): readonly string[] | undefined {
  const config = readTiersConfig();
  if (!Value.Check(TiersAccountsSchema, config)) return undefined;
  return Object.values(config.accounts ?? {}).find((members) => members.includes(provider));
}

function reasonOf(error: string): Reason | undefined {
  if (OUT_OF_QUOTA.test(error)) return "out of quota";
  return RATE_LIMITED.test(error) ? "throttled" : undefined;
}

function cooldownMs(reason: Reason): number {
  const config = readTiersConfig();
  const given = Value.Check(TiersAccountsSchema, config) ? config.cooldowns : undefined;
  const seconds =
    reason === "throttled"
      ? (given?.rateLimitSeconds ?? RATE_SECONDS)
      : (given?.usageLimitSeconds ?? QUOTA_SECONDS);
  return seconds * MS;
}

export function accountResumeAt(error: string, now: number = Date.now()): number | undefined {
  const times = [...error.matchAll(BLOCKED_UNTIL)].map((found) => Date.parse(found[1] ?? ""));
  const later = times.filter((time) => time > now);
  return later.length === 0 ? undefined : Math.min(...later);
}

function avoided(): ReadonlySet<string> {
  return new Set(
    (process.env["PI_TIERS_AVOID"] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

function stickyProvider(request: ModelRouteRequest<Pin>, pin: Pin): string | undefined {
  const last = request.failed?.model ?? request.previous?.model;
  return last?.id === pin.model ? last.provider : undefined;
}

function exhausted(model: string, verdicts: readonly Verdict[]): string {
  const named = verdicts.flatMap((each) =>
    "blocked" in each ? [`${each.provider} (${each.blocked})`] : [],
  );
  return `fleet: no usable account for ${model}: ${named.join(", ")}`;
}

export class AccountRotation {
  private readonly pi: ExtensionAPI;
  private readonly cooled = new Map<string, Cooled>();
  private pin: Pin | undefined;
  private moved: string | undefined;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    pi.on("message_end", (event, ctx) => this.leave(event.message, ctx));
    pi.on("agent_before_settle", (event) => this.continueOn(event));
  }

  async adopt(ctx: ExtensionContext): Promise<void> {
    const model = ctx.model;
    const members = model === undefined ? undefined : accountGroup(model.provider);
    if (model === undefined || members === undefined) return;
    this.pin = {
      model: model.id,
      accounts: [model.provider, ...members.filter((provider) => provider !== model.provider)],
    };
    this.restore(ctx);
    this.pi.registerVirtualModel<Pin>({
      provider: PROVIDER,
      id: MODEL_ID,
      name: `${model.id} on any of its accounts`,
      thinkingLevels: THINKING_LEVELS,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...model.input],
      route: (request, routing) => this.route(request, routing),
    });
    const virtual = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
    if (virtual === undefined) return;
    const level = this.pi.getThinkingLevel();
    if (await this.pi.setModel(virtual).catch(() => false)) this.pi.setThinkingLevel(level);
  }

  private restore(ctx: ExtensionContext): void {
    const now = Date.now();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== COOLED_ENTRY) continue;
      if (Value.Check(CooledSchema, entry.data) && entry.data.untilMs > now)
        this.cooled.set(entry.data.provider, entry.data);
    }
  }

  private noteFailure(provider: string, model: string, error: string): Cooled | undefined {
    const reason = reasonOf(error);
    const pin = this.pin;
    if (reason === undefined || pin?.model !== model || !pin.accounts.includes(provider))
      return undefined;
    const cooled: Cooled = { provider, reason, untilMs: Date.now() + cooldownMs(reason) };
    this.cooled.set(provider, cooled);
    this.pi.appendEntry(COOLED_ENTRY, cooled);
    return cooled;
  }

  private leave(
    message: MessageEndEvent["message"],
    ctx: ExtensionContext,
  ): MessageEndEventResult | undefined {
    if (message.role !== "assistant") return undefined;
    this.moved = undefined;
    if (message.stopReason !== "error") return undefined;
    const cooled = this.noteFailure(message.provider, message.model, message.errorMessage ?? "");
    const pin = this.pin;
    if (cooled === undefined || pin === undefined || ctx.model?.provider !== PROVIDER)
      return undefined;
    const verdicts = pin.accounts.map((provider) => this.judge(provider, pin, ctx));
    if (!verdicts.some((each) => "usable" in each))
      return { message: { ...message, errorMessage: exhausted(pin.model, verdicts) } };
    this.moved = `fleet: ${cooled.provider} is ${cooled.reason} for ${pin.model}; continuing on another account.`;
    return { message: { ...message, errorMessage: this.moved } };
  }

  private continueOn(event: AgentBeforeSettleEvent): AgentBeforeSettleEventResult | undefined {
    const content = this.moved;
    if (content === undefined) return undefined;
    this.moved = undefined;
    const entry = {
      type: "custom_message",
      customType: MOVED_ENTRY,
      content,
      display: true,
    } as const;
    return { entries: [...event.entries, entry], continue: true };
  }

  private judge(provider: string, pin: Pin, ctx: ExtensionContext): Verdict {
    const model = ctx.modelRegistry.find(provider, pin.model);
    if (model === undefined) return { provider, blocked: "does not serve it" };
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { provider, blocked: "no credentials" };
    if (avoided().has(provider)) return { provider, blocked: "avoided by the restart" };
    const cooled = this.cooled.get(provider);
    if (cooled === undefined || cooled.untilMs <= Date.now()) return { provider, usable: model };
    const until = new Date(cooled.untilMs).toISOString();
    return { provider, blocked: `${cooled.reason} until ${until}` };
  }

  private route(request: ModelRouteRequest<Pin>, ctx: ExtensionContext): ModelRoute<Pin> {
    const given = Value.Check(PinSchema, request.state) ? request.state : undefined;
    const pin = this.pin ?? given;
    if (pin === undefined) throw new Error("fleet: the model pinned for this worker is not known");
    const verdicts = pin.accounts.map((provider) => this.judge(provider, pin, ctx));
    const usable = verdicts.filter((each) => "usable" in each);
    const sticky = stickyProvider(request, pin);
    const chosen = usable.find((each) => each.provider === sticky) ?? usable[0];
    if (chosen === undefined) throw new Error(exhausted(pin.model, verdicts));
    return {
      model: chosen.usable,
      thinkingLevel: request.thinkingLevel,
      state: request.state ?? pin,
    };
  }
}
