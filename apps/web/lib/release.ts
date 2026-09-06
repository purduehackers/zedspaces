import type { EditorRelease } from "./builds";
import { env, EnvError } from "./env";

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
