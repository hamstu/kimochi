/**
 * The profile whose Log this window shows. Every account keeps its sessions, notebook, presets and
 * stats in a folder of its own under AppLocalData (`profiles/<key>/`); signed out, the Local
 * profile is AppLocalData itself. Paths stored in the files (a notebook image's `path`) stay
 * relative to the profile; only file-system calls go through `inProfile`.
 *
 * The profile is fixed for the life of the window: switching accounts reloads the windows
 * (`src-tauri/src/account.rs`), so a late write always lands in the profile it was made in.
 */
import { invoke } from "@tauri-apps/api/core";

let root = "";
let loading: Promise<string> | null = null;

/** Ask native once which profile is in use. Never rejects: the Local profile on failure. */
export function loadProfileRoot(): Promise<string> {
  loading ??= invoke<{ root?: unknown }>("profile_current")
    .then((reply) => {
      root = typeof reply?.root === "string" ? reply.root : "";
      return root;
    })
    .catch(() => root);
  return loading;
}

export const profileRoot = (): string => root;

/** A profile-relative path as AppLocalData sees it. */
export function inProfile(path: string): string {
  if (!root) return path;
  return path ? `${root}/${path}` : root;
}

/**
 * While Sync merges another computer's changes into the files (`sync:hold` … `sync:release`), the
 * Log keeps its writes to itself; they are made after it reloads.
 */
let paused = false;
export const writesPaused = (): boolean => paused;
export function setWritesPaused(value: boolean): void {
  paused = value;
}
