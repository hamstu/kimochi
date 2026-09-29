/* Tiny pub/sub for opening the notebook edit modal from anywhere in the main
   window (panel rows, match-chip hover buttons, popover edit requests). App.tsx
   owns the modal state and subscribes here. The modal is independent of the
   notebook drawer — opening it never opens the drawer. */

type Sub = (entryId: string) => void;

const subs = new Set<Sub>();

export function openEditModal(entryId: string): void {
  for (const fn of subs) {
    try {
      fn(entryId);
    } catch (err) {
      console.error(err);
    }
  }
}

export function onEditModalRequest(fn: Sub): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
