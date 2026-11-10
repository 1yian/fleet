import { viewerBuild } from "@fleet/protocol/build";

function ownBuild(): string | undefined {
  try {
    return viewerBuild();
  } catch {
    return undefined;
  }
}

const BUILD = ownBuild();

export const isOwnBuild = (build: string | undefined): boolean =>
  BUILD !== undefined && build === BUILD;
