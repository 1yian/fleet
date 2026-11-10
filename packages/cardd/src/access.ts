import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";
import type { Timings } from "./timing.ts";

const CLOCK_TOLERANCE_SECONDS = 5;
const LOG_EVERY = 60_000;
const NAME = "[a-z0-9]+(-[a-z0-9]+)*(\\.[a-z0-9]+(-[a-z0-9]+)*)*";
const HOST_NAME = new RegExp(`^${NAME}$`);
const TEAM_DOMAIN = new RegExp(`^${NAME}(:\\d{1,5})?$`);
const AUDIENCE_TAG = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export interface AccessConfig {
  readonly host: string;
  readonly team: string;
  readonly audience: string;
  readonly owner: string;
}

export type AccessFlags = readonly [
  host: string | undefined,
  team: string | undefined,
  audience: string | undefined,
  owner: string | undefined,
];

function lowered(value: string, pattern: RegExp, flag: string, form: string): string {
  const lower = value.toLowerCase();
  if (!pattern.test(lower)) throw new Error(`${flag} ${value} must be ${form}`);
  return lower;
}

export function parseAccess(flags: AccessFlags): AccessConfig | undefined {
  const [host, team, audience, owner] = flags;
  if (flags.every((flag) => flag === undefined)) return undefined;
  if (host === undefined || team === undefined || audience === undefined || owner === undefined)
    throw new Error(
      "--public-host, --access-team, --access-aud, and --access-email are set together or not at all",
    );
  return {
    host: lowered(host, HOST_NAME, "--public-host", "a host name, with no scheme, port, or path"),
    team: lowered(
      team,
      TEAM_DOMAIN,
      "--access-team",
      "the Access team domain, such as myteam.cloudflareaccess.com",
    ),
    audience: lowered(
      audience,
      AUDIENCE_TAG,
      "--access-aud",
      "the 64 hex characters of the AUD tag",
    ),
    owner: lowered(owner, EMAIL, "--access-email", "an email address"),
  };
}

function describe(error: unknown): string {
  if (error instanceof errors.JOSEError || !(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

export class Access {
  readonly host: string;
  private readonly owner: string;
  private readonly rules: JWTVerifyOptions;
  private readonly keys: JWTVerifyGetKey;
  private readonly cooldown: number;
  private failedAt = -Infinity;
  private readonly logged = new Map<string, number>();

  constructor(config: AccessConfig, timing: Timings) {
    this.host = config.host;
    this.owner = config.owner;
    this.cooldown = timing.keyCooldown;
    this.rules = {
      algorithms: ["RS256"],
      issuer: `https://${config.team}`,
      audience: config.audience,
      requiredClaims: ["exp"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    };
    this.keys = createRemoteJWKSet(new URL(`https://${config.team}/cdn-cgi/access/certs`), {
      cooldownDuration: timing.keyCooldown,
      cacheMaxAge: timing.keyAge,
    });
  }

  async admits(token: string | undefined): Promise<boolean> {
    try {
      if (token === undefined) throw new Error("the request has no Cf-Access-Jwt-Assertion header");
      const { payload } = await jwtVerify(token, this.lookup, this.rules);
      const email = payload["email"];
      if (typeof email !== "string" || email.toLowerCase() !== this.owner)
        throw new Error("the token is for another email address");
      return true;
    } catch (error) {
      this.note(describe(error));
      return false;
    }
  }

  private readonly lookup: JWTVerifyGetKey = async (header, token) => {
    if (Date.now() < this.failedAt + this.cooldown)
      throw new Error("the signing keys could not be fetched a moment ago");
    try {
      return await this.keys(header, token);
    } catch (error) {
      const unmatched =
        error instanceof errors.JWKSNoMatchingKey ||
        error instanceof errors.JWKSMultipleMatchingKeys;
      if (!unmatched) this.failedAt = Date.now();
      throw error;
    }
  };

  note(reason: string): void {
    const now = Date.now();
    if (now < (this.logged.get(reason) ?? -Infinity) + LOG_EVERY) return;
    this.logged.set(reason, now);
    console.error(`public host refused a request: ${reason}`);
  }
}
