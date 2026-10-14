import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Copy, Eye, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  ConfirmDialog,
  ContextMenu,
  ContextMenuTrigger,
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "@kit";
import { deleteEntry, updateEntry } from "@texthooker/lib/notebook";
import { writeTextSelf } from "@texthooker/lib/clipboardWrite";
import type { NotebookEntry } from "@texthooker/lib/types";
import { entryName, entryTitle } from "./notebookEntry";

/** Asks before an entry is deleted with its notes and images. */
export function DeleteEntryDialog({
  entry,
  onOpenChange,
  onDeleted,
}: {
  /** The entry to delete; the dialog is open while one is given. */
  entry: NotebookEntry | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  return (
    <ConfirmDialog
      open={entry !== null}
      onOpenChange={onOpenChange}
      title={entry ? `Delete ${entryTitle(entry)}?` : ""}
      description="Its notes and images are removed from this session’s notebook. This can’t be undone."
      confirmLabel="Delete"
      tone="danger"
      onConfirm={() => {
        if (!entry) return;
        onOpenChange(false);
        void deleteEntry(entry.id);
        onDeleted?.();
      }}
    />
  );
}

interface Actions {
  onEdit: (entry: NotebookEntry) => void;
  /** Asks to delete; the caller confirms. */
  onDelete: (entry: NotebookEntry) => void;
}

/** What can be done with an entry: its ⋯ menu and a right-click on its row list the same items. */
function EntryMenuItems({
  entry,
  onEdit,
  onDelete,
}: Actions & { entry: NotebookEntry }) {
  const name = entryName(entry);
  return (
    <>
      <MenuItem icon={<Pencil />} onSelect={() => onEdit(entry)}>
        Edit
      </MenuItem>
      {name ? (
        <MenuItem
          icon={<Copy />}
          onSelect={() => void writeTextSelf(name).catch(() => {})}
        >
          Copy name
        </MenuItem>
      ) : null}
      <MenuCheckboxItem
        icon={<Eye />}
        checked={entry.matchEnabled}
        onCheckedChange={(value) =>
          void updateEntry(entry.id, { matchEnabled: value })
        }
      >
        Match in the Log
      </MenuCheckboxItem>
      <MenuSeparator />
      <MenuItem
        icon={<Trash2 />}
        tone="danger"
        onSelect={() => onDelete(entry)}
      >
        Delete…
      </MenuItem>
    </>
  );
}

/** The ⋯ button on an entry's row, shown on hover. */
export function EntryActionsMenu({
  entry,
  ...actions
}: Actions & { entry: NotebookEntry }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          label={`Actions for ${entryTitle(entry)}`}
          size="sm"
          className="nb-row-actions"
          // The list moves between rows with the arrow keys; this button is reached by pointer.
          tabIndex={-1}
        >
          <MoreHorizontal />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end">
        <EntryMenuItems entry={entry} {...actions} />
      </MenuContent>
    </Menu>
  );
}

/** A right-click on any entry's row opens its menu; one menu serves the list. */
export function EntryContextMenu({
  entries,
  children,
  ...actions
}: Actions & { entries: readonly NotebookEntry[]; children: ReactNode }) {
  const [targetId, setTargetId] = useState<string | null>(null);
  // The row the menu is for, lit as a hovered row is while its menu is open.
  const row = useRef<HTMLElement | null>(null);
  const entry = entries.find((e) => e.id === targetId);

  const onContextMenu = (event: MouseEvent) => {
    const rowElement = (event.target as Element).closest<HTMLElement>(
      "[data-entry-menu]",
    );
    const id = rowElement?.dataset.entryMenu;
    if (!id || !entries.some((e) => e.id === id)) {
      event.preventDefault();
      return;
    }
    row.current?.removeAttribute("data-menu-open");
    row.current = rowElement;
    rowElement?.setAttribute("data-menu-open", "");
    setTargetId(id);
  };

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) return;
        row.current?.removeAttribute("data-menu-open");
        row.current = null;
        setTargetId(null);
      }}
    >
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        {children}
      </ContextMenuTrigger>
      <MenuContent>
        {entry ? <EntryMenuItems entry={entry} {...actions} /> : null}
      </MenuContent>
    </ContextMenu>
  );
}
