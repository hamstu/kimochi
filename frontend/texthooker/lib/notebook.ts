import { call, getSnapshot, subscribe } from "../bridge";
import type * as Core from "../core/notebook";
export const createPerson = (
  ...args: Parameters<typeof Core.createPerson>
): Promise<Awaited<ReturnType<typeof Core.createPerson>>> =>
  call("notebook", "createPerson", args);
export const createPlace = (
  ...args: Parameters<typeof Core.createPlace>
): Promise<Awaited<ReturnType<typeof Core.createPlace>>> =>
  call("notebook", "createPlace", args);
export const createThing = (
  ...args: Parameters<typeof Core.createThing>
): Promise<Awaited<ReturnType<typeof Core.createThing>>> =>
  call("notebook", "createThing", args);
export const updateEntry = (
  ...args: Parameters<typeof Core.updateEntry>
): Promise<Awaited<ReturnType<typeof Core.updateEntry>>> =>
  call("notebook", "updateEntry", args);
export const deleteEntry = (
  ...args: Parameters<typeof Core.deleteEntry>
): Promise<Awaited<ReturnType<typeof Core.deleteEntry>>> =>
  call("notebook", "deleteEntry", args);
export const addNote = (
  ...args: Parameters<typeof Core.addNote>
): Promise<Awaited<ReturnType<typeof Core.addNote>>> =>
  call("notebook", "addNote", args);
export const updateNote = (
  ...args: Parameters<typeof Core.updateNote>
): Promise<Awaited<ReturnType<typeof Core.updateNote>>> =>
  call("notebook", "updateNote", args);
export const deleteNote = (
  ...args: Parameters<typeof Core.deleteNote>
): Promise<Awaited<ReturnType<typeof Core.deleteNote>>> =>
  call("notebook", "deleteNote", args);
export const detachImage = (
  ...args: Parameters<typeof Core.detachImage>
): Promise<Awaited<ReturnType<typeof Core.detachImage>>> =>
  call("notebook", "detachImage", args);

export * from "./notebook-read";
export const getNotebook = () => getSnapshot().notebook;
export const getEntry = (id: string) =>
  getNotebook().entries.find((e) => e.id === id);
export const subscribeNotebook = (
  fn: (n: ReturnType<typeof getNotebook>) => void,
) => subscribe((s) => fn(s.notebook));
export const attachImage = async (
  id: string,
  blob: Blob,
  ext: string,
): Promise<Awaited<ReturnType<typeof Core.attachImage>>> =>
  call("notebook", "attachImage", [
    id,
    Array.from(new Uint8Array(await blob.arrayBuffer())),
    ext,
  ]);
