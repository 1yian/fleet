const EMAIL_LOCAL_PART =
  /(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|(?<![\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]+)/u
    .source;
const EMAIL_DOMAIN = /(?:[\p{L}\p{M}\p{N}-]+[.。．｡])+[\p{L}][\p{L}\p{M}\p{N}-]*/u.source;
export const EMAIL_ADDRESS = new RegExp(`${EMAIL_LOCAL_PART}@${EMAIL_DOMAIN}`, "gu");
