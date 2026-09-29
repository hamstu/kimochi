/** Serialize writes per path and replace app data atomically; dialogs retain their granted paths. */
import {
  writeTextFile as write,
  rename,
  BaseDirectory,
  type WriteFileOptions,
} from "@tauri-apps/plugin-fs";
const pending = new Map<string, Promise<void>>();
export async function writeTextFile(
  path: string,
  contents: string,
  options?: WriteFileOptions,
): Promise<void> {
  const key = `${options?.baseDir ?? ""}:${path}`;
  const previous = pending.get(key) || Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(async () => {
      if (options?.baseDir !== BaseDirectory.AppLocalData) {
        await write(path, contents, options);
        return;
      }
      const temporary = `${path}.pending`;
      await write(temporary, contents, options);
      await rename(temporary, path, {
        oldPathBaseDir: options.baseDir,
        newPathBaseDir: options.baseDir,
      });
    });
  pending.set(key, task);
  try {
    await task;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}
