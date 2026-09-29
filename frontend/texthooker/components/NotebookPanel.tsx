/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  BookOpen,
  Download,
  EyeOff,
  NotebookPen,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
  Row,
  Segmented,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@kit";
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
import {
  getActiveSession,
  listSessions,
  renameSession,
  subscribeSessions,
  switchSession,
  updateSessionDescription,
} from "@texthooker/lib/sessions";
import type {
  NotebookEntry,
  NotebookFile,
  NotebookKind,
  SessionMeta,
} from "@texthooker/lib/types";
import "../notebook.css";

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
      <Bar position="top" className="nb-bar">
        <SessionSelect />
        <SessionDetails />
        <BarSpacer />
        <Button variant="ghost" size="sm" onClick={() => setVndbOpen(true)}>
          <Download />
          Import from VNDB
        </Button>
        <AddMenu onAdd={add} />
      </Bar>

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
                  <Button onClick={() => add("person")}>
                    <Plus />
                    Add character
                  </Button>
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
                    />
                  ))}
                </div>
              )}

              <Bar position="bottom" className="nb-foot">
                <span className="k-num">
                  {visible.length === total
                    ? `${total} ${total === 1 ? "entry" : "entries"}`
                    : `${visible.length} of ${total}`}
                </span>
                <BarSpacer />
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
              </Bar>
            </>
          )}
        </div>

        <EditEntryModal
          presentation="pane"
          entryId={editingId}
          onClose={closeEditor}
        />
      </div>

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
}: {
  kind: NotebookKind;
  showLabel: boolean;
  entries: NotebookEntry[];
  current: string | null;
  highlight: boolean;
  editingId: string | null;
  onPick: (id: string) => void;
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
}: {
  entry: NotebookEntry;
  /** Holds the list's tab stop. */
  current: boolean;
  /** Shown as the keyboard/edit selection. */
  selected: boolean;
  editing: boolean;
  onPick: () => void;
}) {
  const name = entryName(entry);
  const reading = entryReading(entry);
  const description = entry.description.trim().replace(/\s+/g, " ");
  const firstNote = entry.notes?.[0]?.text.trim().replace(/\s+/g, " ");
  const preview = description || firstNote || "";
  const noteCount = entry.notes?.length ?? 0;

  return (
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
  );
}

function AddMenu({ onAdd }: { onAdd: (kind: NotebookKind) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm">
          <Plus />
          Add
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
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

/* ── Session context ───────────────────────────────────────────────────── */

function useActiveSession(): [SessionMeta, SessionMeta[]] {
  const [active, setActive] = useState<SessionMeta>(() => getActiveSession());
  const [sessions, setSessions] = useState<SessionMeta[]>(() => listSessions());
  useEffect(
    () =>
      subscribeSessions((manifest) => {
        const next = manifest.sessions.find(
          (session) => session.id === manifest.activeId,
        );
        if (next) setActive(next);
        setSessions(manifest.sessions.slice());
      }),
    [],
  );
  return [active, sessions];
}

function SessionSelect(): ReactNode {
  const [active, sessions] = useActiveSession();
  return (
    <SelectRoot
      value={active.id}
      onValueChange={(id) => {
        if (id !== active.id) void switchSession(id);
      }}
    >
      <SelectTrigger
        variant="ghost"
        size="sm"
        className="nb-session-trigger"
        aria-label="Session"
      >
        <SelectValue>{active.name}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {sessions.map((session) => (
          <SelectItem key={session.id} value={session.id}>
            {session.name}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}

function SessionDetails(): ReactNode {
  const [session] = useActiveSession();
  const [name, setName] = useState(session.name);
  const [desc, setDesc] = useState(session.description);

  useEffect(() => setName(session.name), [session.id, session.name]);
  useEffect(
    () => setDesc(session.description),
    [session.id, session.description],
  );

  const commitName = () => {
    if (name.trim() && name !== session.name) {
      void renameSession(session.id, name.trim());
    } else if (!name.trim()) {
      setName(session.name);
    }
  };
  const commitDesc = () => {
    if (desc !== session.description) {
      void updateSessionDescription(session.id, desc);
    }
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) {
          commitName();
          commitDesc();
        }
      }}
    >
      <PopoverTrigger asChild>
        <IconButton label="Session details" size="sm">
          <NotebookPen />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="nb-session-pop">
        <p className="k-title">Session</p>
        <label className="nb-field">
          <span className="nb-label">Name</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        <label className="nb-field">
          <span className="nb-label">Description</span>
          <Textarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={commitDesc}
            spellCheck={false}
            placeholder="What is this session about?"
          />
        </label>
      </PopoverContent>
    </Popover>
  );
}
