import { SECRET_NAME } from "./redact-guards.ts";

const TICK = String.raw`\u0060`;
const OUTSIDE_SPAN = String.raw`(?<=^(?:[^${TICK}\n]*${TICK}[^${TICK}\n]*${TICK})*[^${TICK}\n]*)`;
const INSIDE_SPAN = String.raw`(?<=^(?:[^${TICK}\n]*${TICK}[^${TICK}\n]*${TICK})*[^${TICK}\n]*${TICK}[^${TICK}\n]*)`;
const CURL_NAME = String.raw`(?<![\w-])c["']*u["']*r["']*l["']*(?![\w.-])`;
const EXPANSION = String.raw`\$['"({\w]`;

export const CURL_SHELL_EXPANSION = new RegExp(
  String.raw`${OUTSIDE_SPAN}${CURL_NAME}[^\n]*?(?:${EXPANSION}|${TICK})|${INSIDE_SPAN}${CURL_NAME}[^${TICK}\n]*?${EXPANSION}`,
  "im",
);

const DATA_SECRET = new RegExp(
  String.raw`(?<=\s)(?:-[^-\s]*[dF]|--(?:data|form|json|url-query)[\w-]*)[\s\S]*?${SECRET_NAME}\s*[=:]`,
  "i",
);

export const CURL_DATA_SECRET = {
  test: (command: string): boolean =>
    DATA_SECRET.test(
      command.replace(/%([\da-f]{2})/gi, (_all, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      ),
    ),
};
