export const EVAL_REFUSED =
  "nothing was evaluated: a stored credential is in this page's form; click Sign in first, or read the page as text";
export const COPY_REFUSED =
  "nothing was copied: a stored credential is in this page's form; click Sign in first, or read the page as text";
export const KEPT =
  "this tab was already open when cardd restarted, and the address you gave did not replace its page (it only changed the part after #, or it was not a page), so a one-time code may still be in it and the tab stays refused: run `browser-axi open <url>` with the address of a different page";
export const RESTARTED =
  "this tab was already open when cardd restarted, and it may show a one-time code that cardd can no longer hide, so nothing was returned: run `browser-axi open <url>` to load a fresh page, then try again";
export const NO_TAB = "you have no tab yet: run `browser-axi open <url>` first";
export const TAB_CLOSED = "your tab was closed: run `browser-axi open <url>` again";
