import { CREDENTIAL_SHOWN } from "./browser-scan.ts";

export interface Refusal {
  readonly stored: string;
  readonly entered: string;
}

const enteredWhile = (done: string): string =>
  `${done}: a password entered through the viewer is still in this page's form; wait until it is submitted or cleared, or read the page as text`;

export const EVAL: Refusal = {
  stored:
    "nothing was evaluated: a stored credential is in this page's form; click Sign in first, or read the page as text",
  entered: enteredWhile("nothing was evaluated"),
};
export const COPY: Refusal = {
  stored:
    "nothing was copied: a stored credential is in this page's form; click Sign in first, or read the page as text",
  entered: enteredWhile("nothing was copied"),
};
export const PICTURE: Refusal = {
  stored: CREDENTIAL_SHOWN,
  entered: enteredWhile("no picture was returned"),
};
export const MARKUP_ENTERED = enteredWhile("the page's HTML was not read");
export const KEPT =
  "this tab was already open when cardd restarted, and the address you gave did not replace its page (it only changed the part after #, or it was not a page), so a one-time code may still be in it and the tab stays refused: run `browser-axi open <url>` with the address of a different page";
export const RESTARTED =
  "this tab was already open when cardd restarted, and it may show a one-time code that cardd can no longer hide, so nothing was returned: run `browser-axi open <url>` to load a fresh page, then try again";
export const NO_TAB = "you have no tab yet: run `browser-axi open <url>` first";
export const TAB_CLOSED = "your tab was closed: run `browser-axi open <url>` again";
