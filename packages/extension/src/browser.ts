import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OPS } from "@fleet/protocol";
import type { Link } from "./link.ts";

export function registerBrowser(pi: ExtensionAPI, link: Link): void {
  pi.registerTool({
    name: "browser",
    label: "Browser",
    description:
      "Drives your own tab in the fleet's one shared Chrome, which is not on your host and never opens a window on anyone's screen. open gives your card its own tab, labelled with your card id and name, and loads a url. Then read, click, type, press, eval and screenshot act on that tab only: you cannot see or touch another card's tab, and a page that tries to open a new window is kept in your tab. login fills the username and password of the site your tab shows from the fleet's Bitwarden Logins project without ever showing them to you: never ask anyone for a password, and never type one. If the project has no entry for the site, login asks your mate to have one added, and you wait. close ends your tab, and your tab is also closed when your card closes or your session is restarted. Use this tool instead of osascript or Safari for every web page. Safari on the captain's Mac is only for what needs his own Mac session.",
    parameters: OPS.browser.args,
    execute: async (_id, params) => {
      const { text, image } = await link.call("browser", params);
      const content =
        image === undefined
          ? [{ type: "text" as const, text }]
          : [
              { type: "text" as const, text },
              { type: "image" as const, data: image.data, mimeType: image.mimeType },
            ];
      return { content, details: {} };
    },
  });
}
