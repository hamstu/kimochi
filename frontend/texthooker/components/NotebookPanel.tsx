/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  BookOpen,
  Download,
  EyeOff,
  Plus,
  Search,
  SearchX,
  StickyNote,
  X,
} from "lucide-react";
import {
  Bar,
  BarSpacer,
  Button,
  Callout,
  EmptyState,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  ResizeHandle,
  Row,
  Segmented,
  Tooltip,
} from "@kit";
import { SessionMenu } from "../../main/SessionMenu";
import { useSetting } from "../../bridge/useSetting";
import {
  DeleteEntryDialog,
  EntryActionsMenu,
  EntryContextMenu,
} from "./EntryActionsMenu";
import { VndbImportDialog } from "./VndbImportDialog";
import { EditEntryModal } from "./EditEntryModal";
import { EntryAvatar } from "./notebookParts";
import {
  KIND_META,
  KIND_ORDER,
  entryHaystack,
  entryName,
  entryReading,
} from "./notebookEntry";
import {
  createPerson,
  createPlace,
  createThing,
  getNotebook,
  subscribeNotebook,
} from "@texthooker/lib/notebook";
import { openEditModal } from "@texthooker/lib/editModal";
import type {
  NotebookEntry,
  NotebookFile,
  NotebookKind,
} from "@texthooker/lib/types";
import "../notebook.css";

/** The editor pane's width range and default, in CSS pixels. */
const EDITOR_MIN = 280;
const EDITOR_MAX = 640;
const EDITOR_WIDTH = 336;

type Filter = "all" | NotebookKind;

const CREATE: Record<NotebookKind, () => Promise<NotebookEntry>> = {
  person: createPerson,
  place: createPlace,
  thing: createThing,
};

interface Props {
  /** Entry open in the editor pane, or null. */
  editingId: string | null;
  onEdit: (entryId: string) => void;
  onCloseEditor: () => void;
  /** A problem opening an edit request from another window. */
  notice?: string;
  onDismissNotice?: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export function NotebookPanel({
  editingId,
  onEdit,
  onCloseEditor,
  notice,
  onDismissNotice,
}: Props) {
  const [nb, setNb] = useState<NotebookFile>(() => getNotebook());
  const [vndbOpen, setVndbOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<NotebookEntry | null>(null);
  const [editorWidth, setEditorWidth] = useSetting<number>(
    "notebookEditorWidth",
    EDITOR_WIDTH,
  );
  // The width while the pane's edge is being dragged.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeNotebook((next) => setNb(next)), []);

  const counts = useMemo(() => {
    const c: Record<NotebookKind, number> = { person: 0, place: 0, thing: 0 };
    for (const entry of nb.entries) c[entry.kind] += 1;
    return c;
  }, [nb]);

  const haystacks = useMemo(
    () => new Map(nb.entries.map((e) => [e.id, entryHaystack(e)])),
    [nb],
  );

  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const kinds = filter === "all" ? KIND_ORDER : [filter];
    return kinds
      .map((kind) => ({
        kind,
        entries: nb.entries.filter(
          (e) =>
            e.kind === kind &&
            (!needle || (haystacks.get(e.id) ?? "").includes(needle)),
        ),
      }))
      .filter((group) => group.entries.length > 0);
  }, [nb, filter, needle, haystacks]);
  const visible = useMemo(() => groups.flatMap((g) => g.entries), [groups]);

  const focusRow = useCallback((id: string) => {
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-entry-id="${CSS.escape(id)}"]`,
    );
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  }, []);

  // The row being edited is the current row; requests from the Log bring it into view.
  useEffect(() => {
    if (!editingId) return;
    setActiveId(editingId);
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector(`[data-entry-id="${CSS.escape(editingId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }, [editingId]);

  // "/" or ⌘F / Ctrl+F jumps to search from anywhere in the window.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (
        (event.key === "/" && !mod && !isTypingTarget(event.target)) ||
        (mod && event.key.toLowerCase() === "f")
      ) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current =
    activeId && visible.some((e) => e.id === activeId)
      ? activeId
      : (visible[0]?.id ?? null);

  const move = (id: string | undefined) => {
    if (!id) return;
    setActiveId(id);
    focusRow(id);
    if (editingId) onEdit(id);
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = visible.findIndex((e) => e.id === current);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(visible[Math.min(visible.length - 1, index + 1)]?.id);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index <= 0) searchRef.current?.focus();
      else move(visible[index - 1]?.id);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(visible[0]?.id);
    } else if (event.key === "End") {
      event.preventDefault();
      move(visible[visible.length - 1]?.id);
    } else if (event.key === "Escape" && editingId) {
      event.preventDefault();
      onCloseEditor();
    }
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && current) {
      event.preventDefault();
      move(current);
    } else if (event.key === "Enter" && current) {
      event.preventDefault();
      setActiveId(current);
      onEdit(current);
    } else if (event.key === "Escape") {
      if (query) {
        event.preventDefault();
        setQuery("");
      } else {
        searchRef.current?.blur();
      }
    }
  };

  const add = (kind: NotebookKind) => {
    setQuery("");
    if (filter !== "all" && filter !== kind) setFilter(kind);
    void CREATE[kind]().then((entry) => {
      setActiveId(entry.id);
      openEditModal(entry.id);
    });
  };

  const closeEditor = () => {
    const id = editingId;
    onCloseEditor();
    if (id) requestAnimationFrame(() => focusRow(id));
  };

  const total = nb.entries.length;
  const filterOptions = [
    { value: "all" as const, label: <FilterLabel label="All" count={total} /> },
    ...KIND_ORDER.map((kind) => ({
      value: kind,
      label: <FilterLabel label={KIND_META[kind].many} count={counts[kind]} />,
    })),
  ];

  return (
    <div className="nb">
      <div className="nb-body">
        <div className="nb-main">
          {notice ? (
            <Callout tone="danger" className="nb-callout">
              <span>{notice}</span>
              {onDismissNotice ? (
                <Button variant="ghost" size="sm" onClick={onDismissNotice}>
                  Dismiss
                </Button>
              ) : null}
            </Callout>
          ) : null}

          {total === 0 ? (
            <EmptyState
              className="nb-empty"
              icon={<BookOpen />}
              title="This notebook is empty"
              actions={
                <>
                  <Button variant="primary" onClick={() => setVndbOpen(true)}>
                    <Download />
                    Import from VNDB
                  </Button>
                  <AddMenu onAdd={add} label="Add item" />
                </>
              }
            >
              Keep the cast, places and things of this session here. Names you
              add are recognised in the Log as you read.
            </EmptyState>
          ) : (
            <>
              <div className="nb-filter">
                <div className="nb-search">
                  <Search />
                  <Input
                    ref={searchRef}
                    size="sm"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onSearchKeyDown}
                    placeholder="Search"
                    aria-label="Search the notebook"
                    aria-controls="nb-list"
                  />
                  <span className="nb-search-end">
                    {query ? (
                      <IconButton
                        label="Clear search"
                        size="sm"
                        onClick={() => {
                          setQuery("");
                          searchRef.current?.focus();
                        }}
                      >
                        <X />
                      </IconButton>
                    ) : (
                      <Kbd>/</Kbd>
                    )}
                  </span>
                </div>
                <Segmented
                  aria-label="Show"
                  value={filter}
                  onValueChange={setFilter}
                  options={filterOptions}
                />
                <span className="nb-filter-divider" aria-hidden />
                {/* An icon when the strip is narrow, labelled when there's room (notebook.css). */}
                <Tooltip content="Import from VNDB">
                  <IconButton
                    label="Import from VNDB"
                    size="sm"
                    className="nb-vndb-icon"
                    onClick={() => setVndbOpen(true)}
                  >
                    <Download />
                  </IconButton>
                </Tooltip>
                <Button
                  size="sm"
                  variant="ghost"
                  className="nb-vndb-wide"
                  onClick={() => setVndbOpen(true)}
                >
                  <Download />
                  Import from VNDB
                </Button>
                <AddMenu onAdd={add} />
              </div>

              {visible.length === 0 ? (
                needle ? (
                  <EmptyState
                    className="nb-empty"
                    icon={<SearchX />}
                    title={`Nothing matches “${query.trim()}”`}
                    actions={
                      <Button size="sm" onClick={() => setQuery("")}>
                        Clear search
                      </Button>
                    }
                  >
                    Search looks at names, readings, aliases, descriptions and
                    notes
                    {filter !== "all"
                      ? ` in ${KIND_META[filter].many.toLowerCase()}`
                      : ""}
                    .
                  </EmptyState>
                ) : filter !== "all" ? (
                  <EmptyState
                    className="nb-empty"
                    icon={KIND_META[filter].icon}
                    title={`No ${KIND_META[filter].many.toLowerCase()} yet`}
                    actions={
                      <Button size="sm" onClick={() => add(filter)}>
                        <Plus />
                        Add {KIND_META[filter].one.toLowerCase()}
                      </Button>
                    }
                  />
                ) : null
              ) : (
                <EntryContextMenu
                  entries={visible}
                  onEdit={(entry) => {
                    setActiveId(entry.id);
                    onEdit(entry.id);
                  }}
                  onDelete={setDeleting}
                >
                  <div
                    id="nb-list"
                    ref={listRef}
                    className="nb-list"
                    role="listbox"
                    aria-label="Notebook entries"
                    onKeyDown={onListKeyDown}
                  >
                    {groups.map((group) => (
                      <GroupRows
                        key={group.kind}
                        kind={group.kind}
                        showLabel={filter === "all"}
                        entries={group.entries}
                        current={current}
                        highlight={activeId !== null || editingId !== null}
                        editingId={editingId}
                        onPick={(id) => {
                          setActiveId(id);
                          onEdit(id);
                        }}
                        onDelete={setDeleting}
                      />
                    ))}
                  </div>
                </EntryContextMenu>
              )}
            </>
          )}
        </div>

        <EditEntryModal
          presentation="pane"
          entryId={editingId}
          onClose={closeEditor}
          paneWidth={liveWidth ?? editorWidth}
          resizeHandle={
            <ResizeHandle
              edge="start"
              width={liveWidth ?? editorWidth}
              min={EDITOR_MIN}
              max={EDITOR_MAX}
              reset={EDITOR_WIDTH}
              label="Resize editor"
              onLive={setLiveWidth}
              onCommit={(width) => void setEditorWidth(width)}
            />
          }
        />
      </div>

      {/* Across the whole notebook, under the editor too: the count, the keys and the session. */}
      <Bar position="bottom" className="nb-foot">
        {total > 0 ? (
          <span className="k-num">
            {visible.length === total
              ? `${total} ${total === 1 ? "entry" : "entries"}`
              : `${visible.length} of ${total}`}
          </span>
        ) : null}
        <BarSpacer />
        {total > 0 ? (
          <span className="nb-hints">
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              Move
            </span>
            <span>
              <Kbd>↵</Kbd>
              Edit
            </span>
            <span>
              <Kbd>/</Kbd>
              Search
            </span>
          </span>
        ) : null}
        <SessionMenu />
      </Bar>

      <DeleteEntryDialog
        entry={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={() => {
          if (deleting?.id === editingId) onCloseEditor();
        }}
      />

      <VndbImportDialog open={vndbOpen} onOpenChange={setVndbOpen} />
    </div>
  );
}

function FilterLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      {label}
      <span className="nb-count">{count}</span>
    </>
  );
}

function GroupRows({
  kind,
  showLabel,
  entries,
  current,
  highlight,
  editingId,
  onPick,
  onDelete,
}: {
  kind: NotebookKind;
  showLabel: boolean;
  entries: NotebookEntry[];
  current: string | null;
  highlight: boolean;
  editingId: string | null;
  onPick: (id: string) => void;
  onDelete: (entry: NotebookEntry) => void;
}) {
  return (
    <>
      {showLabel ? (
        <div className="nb-group" role="presentation">
          {KIND_META[kind].many}
          <span className="k-num">{entries.length}</span>
        </div>
      ) : null}
      {entries.map((entry) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          current={entry.id === current}
          selected={highlight && entry.id === current}
          editing={entry.id === editingId}
          onPick={() => onPick(entry.id)}
          onDelete={onDelete}
        />
      ))}
    </>
  );
}

function EntryRow({
  entry,
  current,
  selected,
  editing,
  onPick,
  onDelete,
}: {
  entry: NotebookEntry;
  /** Holds the list's tab stop. */
  current: boolean;
  /** Shown as the keyboard/edit selection. */
  selected: boolean;
  editing: boolean;
  onPick: () => void;
  onDelete: (entry: NotebookEntry) => void;
}) {
  const name = entryName(entry);
  const reading = entryReading(entry);
  const description = entry.description.trim().replace(/\s+/g, " ");
  const firstNote = entry.notes?.[0]?.text.trim().replace(/\s+/g, " ");
  const preview = description || firstNote || "";
  const noteCount = entry.notes?.length ?? 0;

  return (
    <div className="nb-row-wrap" data-entry-menu={entry.id}>
      <Row
        role="option"
        aria-selected={selected}
        tabIndex={current ? 0 : -1}
        data-entry-id={entry.id}
        data-editing={editing ? "" : undefined}
        className="nb-row"
        icon={<EntryAvatar entry={entry} />}
        onClick={onPick}
        trailing={
          <span className="nb-trail">
            {!entry.matchEnabled ? (
              <span
                className="nb-meta"
                aria-label="Not matched in the Log"
                title="Not matched in the Log"
              >
                <EyeOff />
              </span>
            ) : null}
            {noteCount > 0 ? (
              <span
                className="nb-meta"
                aria-label={`${noteCount} note${noteCount === 1 ? "" : "s"}`}
                title={`${noteCount} note${noteCount === 1 ? "" : "s"}`}
              >
                <StickyNote />
                {noteCount}
              </span>
            ) : null}
          </span>
        }
      >
        <span className="nb-row-title">
          {name ? (
            <span className="nb-name" lang="ja" translate="no">
              {name}
            </span>
          ) : (
            <span className="nb-name nb-name-empty">
              New {KIND_META[entry.kind].one.toLowerCase()}
            </span>
          )}
          {reading ? (
            <span className="nb-reading" lang="ja" translate="no">
              {reading}
            </span>
          ) : null}
          {entry.aliases.length > 0 ? (
            <span className="nb-aliases" lang="ja" translate="no">
              {entry.aliases.join("、")}
            </span>
          ) : null}
        </span>
        <span className={preview ? "nb-sub" : "nb-sub nb-sub-empty"}>
          {preview || "No description"}
        </span>
      </Row>
      <EntryActionsMenu entry={entry} onEdit={onPick} onDelete={onDelete} />
    </div>
  );
}

/** Add, then choose what: a character, a place or a thing. */
function AddMenu({
  onAdd,
  label,
}: {
  onAdd: (kind: NotebookKind) => void;
  /** The empty notebook's larger button says "Add item"; the toolbar's, "Add". */
  label?: string;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size={label ? undefined : "sm"}>
          <Plus />
          {label ?? "Add"}
        </Button>
      </MenuTrigger>
      <MenuContent align={label ? "center" : "end"}>
        {KIND_ORDER.map((kind) => (
          <MenuItem
            key={kind}
            icon={KIND_META[kind].icon}
            onSelect={() => onAdd(kind)}
          >
            {KIND_META[kind].one}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
