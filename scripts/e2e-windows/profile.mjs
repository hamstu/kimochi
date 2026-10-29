import path from "node:path";

export const IDENTIFIER = "dev.kimochi.e2e";

/** Refuse installed-app storage before the harness changes any app setting. */
export function assertIsolatedPaths(roaming, local) {
  for (const directory of [roaming, local]) {
    if (
      typeof directory !== "string" ||
      !path.win32.isAbsolute(directory) ||
      path.win32.basename(path.win32.normalize(directory)).toLowerCase() !==
        IDENTIFIER
    ) {
      throw new Error(
        `Refusing to test an app outside the ${IDENTIFIER} profile`,
      );
    }
  }
}
