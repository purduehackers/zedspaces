import type { EditorRelease } from "./builds";
import { env, EnvError } from "./env";

/** Builds predating the web updater need one bootstrap upgrade before they can defer. */
export function canDeferUpgrade(clientBuild: string): boolean {
  const e = env();
  return clientBuild.startsWith("dev") ||
    (e.ZS_EDITOR_BUNDLES?.split(",").includes(clientBuild) === true &&
      e.ZS_EDITOR_UPDATE_BUILDS?.split(",").includes(clientBuild) === true);
}

export function currentRelease(): EditorRelease {
  const e = env();
  if (!e.ZS_IMAGE_REF || !e.ZS_SERVER_BUILD_ID) {
    throw new EnvError(["ZS_IMAGE_REF", "ZS_SERVER_BUILD_ID"], "The editor release is not configured");
  }
  return {
    imageRef: e.ZS_IMAGE_REF,
    serverBuild: e.ZS_SERVER_BUILD_ID,
    clientBuild: e.ZS_CLIENT_BUILD_ID ?? e.ZS_SERVER_BUILD_ID,
  };
}
