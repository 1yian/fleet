import Type, { type Static, type TSchema } from "typebox";

export const BROWSER_ACTIONS = [
  "open",
  "read",
  "click",
  "type",
  "press",
  "eval",
  "screenshot",
  "login",
  "close",
] as const;

export const BrowserArgsSchema = Type.Object({
  action: Type.Enum(BROWSER_ACTIONS, {
    description:
      "open: give your card its own tab and load url (or load url in it again). read: the visible text of the page or of selector, or its HTML. click: click the element that selector names, or the point x,y. type: type text into the element that selector names (or the focused one). press: press one key such as Enter, Tab or Escape. eval: run a JavaScript expression in the page and return its value. screenshot: an image of the tab. login: fill the username and password of site from the fleet's Bitwarden Logins project, without ever showing them to you. close: close your tab",
  }),
  url: Type.Optional(Type.String({ description: "open: the http or https address to load" })),
  selector: Type.Optional(
    Type.String({
      description: "read, click, type: a CSS selector. Omit it to mean the whole page",
    }),
  ),
  x: Type.Optional(Type.Number({ description: "click: the horizontal point in CSS pixels" })),
  y: Type.Optional(Type.Number({ description: "click: the vertical point in CSS pixels" })),
  text: Type.Optional(Type.String({ description: "type: the text to type" })),
  key: Type.Optional(
    Type.String({ description: "press: Enter, Tab, Escape, Backspace, ArrowDown ..." }),
  ),
  submit: Type.Optional(Type.Boolean({ description: "type: press Enter after the text" })),
  expression: Type.Optional(Type.String({ description: "eval: a JavaScript expression" })),
  html: Type.Optional(Type.Boolean({ description: "read: return HTML instead of text" })),
  fullPage: Type.Optional(
    Type.Boolean({ description: "screenshot: capture the whole page, not only the viewport" }),
  ),
  site: Type.Optional(
    Type.String({
      description:
        "login: the site to log in to, such as github.com. Omit it to use the site your tab is on. The tab must already show that site's login page",
    }),
  ),
  card: Type.Optional(
    Type.Integer({
      description:
        "A mate names the card whose tab it drives, a card of its lane (main: any card). A worker never gives it: its tab is its own card's",
    }),
  ),
  captain: Type.Optional(
    Type.String({
      description:
        "Why the captain is needed in this tab (a passkey, a one-time code, terms, a payment). The fleet then opens the Browser tab in the lane's workspace when the captain is there, and in main's workspace when he is not",
    }),
  ),
  host: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "A mate's own host name, for a card that has no worker (browser-axi fills it from the lane). A worker never gives it: its tab is in the browser of the host that its worker runs on",
    }),
  ),
});
export type BrowserArgs = Static<typeof BrowserArgsSchema>;

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const BROWSER_OPS = {
  browser: {
    roles: ["worker", "mate"],
    args: BrowserArgsSchema,
    result: Type.Object({
      text: Type.String(),
      image: Type.Optional(Type.Object({ mimeType: Type.String(), data: Type.String() })),
      captain: Type.Optional(Type.String()),
    }),
  },
  "browser.release": {
    roles: ["mate"],
    args: Type.Object({ card: Type.Integer() }),
    result: Type.Object({ closed: Type.Integer(), note: Nullable(Type.String()) }),
  },
  "browser.view": {
    roles: ["worker", "mate"],
    args: Type.Object({
      card: Type.Optional(Type.Integer()),
      captain: Type.Optional(Type.Boolean()),
      host: Type.Optional(Type.String({ minLength: 1 })),
    }),
    result: Type.Object({
      host: Nullable(Type.String()),
      browsers: Type.Array(Type.Object({ host: Type.String(), endpoint: Type.String() })),
      problem: Nullable(Type.String()),
      tabs: Type.Array(
        Type.Object({
          card: Type.Integer(),
          name: Type.String(),
          label: Type.String(),
          target: Type.String(),
          host: Type.String(),
          live: Type.Boolean(),
          title: Type.String(),
          url: Type.String(),
        }),
      ),
    }),
  },
  "browser.frame": {
    roles: ["worker", "mate"],
    args: Type.Object({ target: Type.String() }),
    result: Type.Object({
      image: Nullable(Type.Object({ mimeType: Type.String(), data: Type.String() })),
      note: Nullable(Type.String()),
    }),
  },
  "browser.summon": {
    roles: ["mate"],
    args: Type.Object({ card: Type.Integer(), why: Type.String({ minLength: 1 }) }),
    result: Type.Object({ told: Type.Boolean() }),
  },
} as const;
