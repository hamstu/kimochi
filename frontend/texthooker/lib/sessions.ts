import { call, getSnapshot, subscribe } from "../bridge";
import type * as Core from "../core/sessions";
export const createSession = (
  ...args: Parameters<typeof Core.createSession>
): Promise<Awaited<ReturnType<typeof Core.createSession>>> =>
  call("sessions", "createSession", args);
export const switchSession = (
  ...args: Parameters<typeof Core.switchSession>
): Promise<Awaited<ReturnType<typeof Core.switchSession>>> =>
  call("sessions", "switchSession", args);
export const renameSession = (
  ...args: Parameters<typeof Core.renameSession>
): Promise<Awaited<ReturnType<typeof Core.renameSession>>> =>
  call("sessions", "renameSession", args);
export const reorderSessions = (
  ...args: Parameters<typeof Core.reorderSessions>
): Promise<Awaited<ReturnType<typeof Core.reorderSessions>>> =>
  call("sessions", "reorderSessions", args);
export const deleteSession = (
  ...args: Parameters<typeof Core.deleteSession>
): Promise<Awaited<ReturnType<typeof Core.deleteSession>>> =>
  call("sessions", "deleteSession", args);
export const updateSessionDescription = (
  ...args: Parameters<typeof Core.updateSessionDescription>
): Promise<Awaited<ReturnType<typeof Core.updateSessionDescription>>> =>
  call("sessions", "updateSessionDescription", args);

export const getManifest = () => getSnapshot().sessions;
export const getActiveSession = () =>
  getManifest().sessions.find((s) => s.id === getManifest().activeId)!;
export const listSessions = () => getManifest().sessions;
export const subscribeSessions = (
  fn: (m: ReturnType<typeof getManifest>) => void,
) => subscribe((s) => fn(s.sessions));
