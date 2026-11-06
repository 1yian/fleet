import { isLocal, onHost, rootOf } from "./host.ts";

const DEFAULT_ROOT = "~/.fleet/app";
const ENTRY = "packages/extension/src/index.ts";

const FIND_ENTRY = `case $1 in
  "~/"*) root=$HOME/\${1#"~/"} ;;
  *) root=$1 ;;
esac
entry=$root/${ENTRY}
[ -f "$entry" ] || { echo "$1 has no ${ENTRY}" >&2; exit 1; }
printf %s "$entry"`;

export async function extensionOn(host: string, own: string): Promise<string> {
  if (isLocal(host)) return own;
  const root = rootOf(host) ?? DEFAULT_ROOT;
  try {
    return await onHost(host, ["sh", "-c", FIND_ENTRY, "extension", root]);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `no fleet extension to start a worker with on ${host}: ${why}. A worker loads the extension from the fleet checkout of the host it starts on. Set roots.${host} in this lane's config/lane.json to that checkout.`,
      { cause: error },
    );
  }
}
