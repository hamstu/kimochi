/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Check, ImagePlus, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  Bar,
  BarSpacer,
  Button,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  IconButton,
  Input,
  Switch,
  Textarea,
} from "@kit";
import {
  addNote,
  attachImage,
  computeMentions,
  deleteEntry,
  deleteNote,
  detachImage,
  updateEntry,
  updateNote,
} from "@texthooker/lib/notebook";
import { useNotebookEntry } from "@texthooker/hooks/useNotebookEntry";
import { snapshotLines } from "@texthooker/lib/store";
import type {
  NotebookEntry,
  NotebookImage,
  NotebookNote,
  PersonEntry,
  PlaceOrThingEntry,
} from "@texthooker/lib/types";
import { EntryAvatar } from "./notebookParts";
import {
  KIND_META,
  entryName,
  entryReading,
  useImageUrl,
} from "./notebookEntry";
import "../notebook.css";

interface Props {
  /** Entry to edit, or null when closed. */
  entryId: string | null;
  onClose: () => void;
  /**
   * `dialog` (default) is a centred modal. `pane` renders inline as the Notebook window's side
   * editor, so the list stays visible and another entry can be picked while editing.
   */
  presentation?: "dialog" | "pane";
}

/** IME composition (Japanese input) must never commit a field on Enter. */
const composing = (event: ReactKeyboardEvent): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229;

export function EditEntryModal({
  entryId,
  onClose,
  presentation = "dialog",
}: Props) {
  const entry = useNotebookEntry(entryId ?? "");
  const open = entryId !== null && entry !== undefined;
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => setConfirmOpen(false), [entryId]);

  const title = entry
    ? entryName(entry) || `New ${KIND_META[entry.kind].one.toLowerCase()}`
    : "";
  const reading = entry ? entryReading(entry) : "";

  const confirm = entry ? (
    <ConfirmDialog
      open={confirmOpen}
      onOpenChange={setConfirmOpen}
      title={`Delete ${title}?`}
      description="Its notes and images are removed from this session’s notebook. This can’t be undone."
      confirmLabel="Delete"
      tone="danger"
      onConfirm={() => {
        setConfirmOpen(false);
        void deleteEntry(entry.id);
        onClose();
      }}
    />
  ) : null;

  if (presentation === "pane") {
    if (!open || !entry) return null;
    return (
      <aside
        className="nb-editor"
        aria-label={`Edit ${title}`}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !confirmOpen && !event.defaultPrevented) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="nb-editor-head">
          <EntryAvatar entry={entry} large />
          <div>
            <h2 className="nb-editor-title" lang="ja" translate="no">
              {title}
            </h2>
            <span className="nb-editor-kind">
              {KIND_META[entry.kind].one}
              {reading ? (
                <span lang="ja" translate="no">
                  {" · "}
                  {reading}
                </span>
              ) : null}
            </span>
          </div>
          <IconButton label="Close editor" size="sm" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <div className="nb-editor-body">
          <EntryForm key={entry.id} entry={entry} />
        </div>
        <Bar position="bottom" className="nb-editor-foot">
          <Mentions entry={entry} />
          <BarSpacer />
          <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
            <Trash2 />
            Delete
          </Button>
        </Bar>
        {confirm}
      </aside>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {entry ? (
        <DialogContent
          title={
            <span className="nb-dialog-title">
              <EntryAvatar entry={entry} />
              <span lang="ja" translate="no">
                {title}
              </span>
            </span>
          }
          description={KIND_META[entry.kind].one}
          footer={
            <>
              <span className="k-dialog-footer-start nb-hint">
                <Mentions entry={entry} />
              </span>
              <Button variant="ghost" onClick={() => setConfirmOpen(true)}>
                <Trash2 />
                Delete
              </Button>
              <DialogClose asChild>
                <Button variant="primary">Done</Button>
              </DialogClose>
            </>
          }
        >
          <EntryForm key={entry.id} entry={entry} />
          {confirm}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function Mentions({ entry }: { entry: NotebookEntry }) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    setCount(computeMentions(entry.id, snapshotLines()).length);
  }, [entry.id, entry.matchEnabled, entry]);
  if (count === null) return null;
  return (
    <span className="k-num">
      {count === 0
        ? "No mentions in this session"
        : `${count} mention${count === 1 ? "" : "s"} in this session`}
    </span>
  );
}

/* ── Form ──────────────────────────────────────────────────────────────── */

function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="nb-field">
      <label className="nb-label" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? <span className="nb-label-hint">{hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

function EntryForm({ entry }: { entry: NotebookEntry }) {
  const id = useId();
  return (
    <div className="nb-form">
      {entry.kind === "person" ? (
        <PersonFields entry={entry} />
      ) : (
        <PlaceThingFields entry={entry} />
      )}
      <AliasesField
        id={`${id}-aliases`}
        value={entry.aliases}
        onChange={(aliases) => void updateEntry(entry.id, { aliases })}
      />
      <MatchToggles entry={entry} />
      <div className="nb-section-rule" role="presentation" />
      <Field label="Description" htmlFor={`${id}-desc`}>
        <Textarea
          id={`${id}-desc`}
          value={entry.description}
          onChange={(e) =>
            void updateEntry(entry.id, { description: e.target.value })
          }
          spellCheck={false}
          placeholder="Who or what this is"
        />
      </Field>
      <NotesSection entry={entry} />
      <ImageStrip entry={entry} />
    </div>
  );
}

function PersonFields({ entry }: { entry: PersonEntry }) {
  const id = useId();
  const commitPatch = (patch: Partial<PersonEntry>) =>
    void updateEntry(entry.id, patch);

  return (
    <div className="nb-form-grid">
      <Field label="Family name" hint="姓" htmlFor={`${id}-fam`}>
        <Input
          id={`${id}-fam`}
          className="nb-jp"
          lang="ja"
          value={entry.family}
          onChange={(e) => commitPatch({ family: e.target.value })}
          placeholder="田中"
        />
      </Field>
      <Field label="Given name" hint="名" htmlFor={`${id}-giv`}>
        <Input
          id={`${id}-giv`}
          className="nb-jp"
          lang="ja"
          value={entry.given}
          onChange={(e) => commitPatch({ given: e.target.value })}
          placeholder="太郎"
        />
      </Field>
      <Field label="Reading" htmlFor={`${id}-famr`}>
        <Input
          id={`${id}-famr`}
          className="nb-jp"
          lang="ja"
          value={entry.familyReading ?? ""}
          onChange={(e) =>
            commitPatch({ familyReading: e.target.value || undefined })
          }
          placeholder="たなか"
        />
      </Field>
      <Field label="Reading" htmlFor={`${id}-givr`}>
        <Input
          id={`${id}-givr`}
          className="nb-jp"
          lang="ja"
          value={entry.givenReading ?? ""}
          onChange={(e) =>
            commitPatch({ givenReading: e.target.value || undefined })
          }
          placeholder="たろう"
        />
      </Field>
    </div>
  );
}

function PlaceThingFields({ entry }: { entry: PlaceOrThingEntry }) {
  const id = useId();
  const commitPatch = (patch: Partial<PlaceOrThingEntry>) =>
    void updateEntry(entry.id, patch);

  return (
    <div className="nb-form-grid">
      <Field label="Name" htmlFor={`${id}-name`}>
        <Input
          id={`${id}-name`}
          className="nb-jp"
          lang="ja"
          value={entry.name}
          onChange={(e) => commitPatch({ name: e.target.value })}
          placeholder={entry.kind === "place" ? "東京" : "天使の指輪"}
        />
      </Field>
      <Field label="Reading" htmlFor={`${id}-reading`}>
        <Input
          id={`${id}-reading`}
          className="nb-jp"
          lang="ja"
          value={entry.reading ?? ""}
          onChange={(e) =>
            commitPatch({ reading: e.target.value || undefined })
          }
          placeholder={entry.kind === "place" ? "とうきょう" : "てんしのゆびわ"}
        />
      </Field>
    </div>
  );
}

function MatchToggles({ entry }: { entry: NotebookEntry }) {
  const given = entry.kind === "person" ? entry.given.trim() : "";
  return (
    <div className="nb-toggles">
      <label className="nb-toggle">
        <div>
          <span className="nb-toggle-label">Match this entry</span>
          <span className="nb-toggle-desc">
            Recognise its name and aliases in the Log
          </span>
        </div>
        <Switch
          checked={entry.matchEnabled}
          onCheckedChange={(v) =>
            void updateEntry(entry.id, { matchEnabled: v })
          }
        />
      </label>
      {entry.kind === "person" ? (
        <label className="nb-toggle">
          <div>
            <span className="nb-toggle-label">Match given name alone</span>
            <span className="nb-toggle-desc">
              Also match{" "}
              {given ? (
                <span className="nb-jp" lang="ja">
                  {given}
                </span>
              ) : (
                "the given name"
              )}{" "}
              on its own
            </span>
          </div>
          <Switch
            checked={entry.matchGivenAlone}
            onCheckedChange={(v) =>
              void updateEntry(entry.id, { matchGivenAlone: v })
            }
          />
        </label>
      ) : null}
    </div>
  );
}

/* ── Aliases: removable chips ─────────────────────────────────────────── */

const ALIAS_SPLIT = /[,、，]/;

function AliasesField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (text: string) => {
    const next = [...value];
    for (const part of text.split(ALIAS_SPLIT)) {
      const alias = part.trim();
      if (alias && !next.includes(alias)) next.push(alias);
    }
    if (next.length !== value.length) onChange(next);
    setDraft("");
  };

  return (
    <Field label="Aliases" hint="Enter or comma to add" htmlFor={id}>
      <div
        className="k-field nb-chips"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {value.map((alias, i) => (
          <span key={`${alias}-${i}`} className="nb-chip" lang="ja">
            {alias}
            <button
              type="button"
              aria-label={`Remove ${alias}`}
              title="Remove alias"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <X />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          value={draft}
          lang="ja"
          spellCheck={false}
          placeholder={value.length ? "" : "オカリン, 助手"}
          onChange={(e) => {
            const next = e.target.value;
            if (ALIAS_SPLIT.test(next)) commit(next);
            else setDraft(next);
          }}
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && !draft && value.length > 0) {
              e.preventDefault();
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => commit(draft)}
        />
      </div>
    </Field>
  );
}

/* ── Notes ─────────────────────────────────────────────────────────────── */

function NotesSection({ entry }: { entry: NotebookEntry }) {
  const [draft, setDraft] = useState("");
  const id = useId();

  const commitDraft = () => {
    const t = draft.trim();
    if (!t) return;
    addNote(entry.id, t);
    setDraft("");
  };

  const notes = entry.notes ?? [];

  return (
    <Field
      label="Notes"
      hint={notes.length ? <span className="k-num">{notes.length}</span> : null}
      htmlFor={id}
    >
      {notes.length > 0 ? (
        <div className="nb-notes">
          {notes.map((note) => (
            <NoteRow key={note.id} entryId={entry.id} note={note} />
          ))}
        </div>
      ) : null}
      <div className="nb-note-add">
        <Input
          id={id}
          size="sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft();
            }
          }}
          placeholder="Add a quick note…"
        />
        <IconButton
          label="Add note"
          size="sm"
          onClick={commitDraft}
          disabled={!draft.trim()}
        >
          <Plus />
        </IconButton>
      </div>
    </Field>
  );
}

function NoteRow({ entryId, note }: { entryId: string; note: NotebookNote }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== note.text) updateNote(entryId, note.id, t);
    else setDraft(note.text);
  };

  if (editing) {
    return (
      <div className="nb-note">
        <Input
          autoFocus
          size="sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDraft(note.text);
              setEditing(false);
            }
          }}
          onBlur={commit}
        />
        <IconButton
          label="Save note"
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
        >
          <Check />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="nb-note">
      <span
        className="nb-note-text"
        onDoubleClick={() => {
          setDraft(note.text);
          setEditing(true);
        }}
      >
        {note.text}
      </span>
      <span className="nb-note-actions">
        <IconButton
          label="Edit note"
          size="sm"
          onClick={() => {
            setDraft(note.text);
            setEditing(true);
          }}
        >
          <Pencil />
        </IconButton>
        <IconButton
          label="Delete note"
          size="sm"
          onClick={() => deleteNote(entryId, note.id)}
        >
          <X />
        </IconButton>
      </span>
    </div>
  );
}

/* ── Images ────────────────────────────────────────────────────────────── */

function ImageStrip({ entry }: { entry: NotebookEntry }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(
    async (files: FileList | File[] | null | undefined) => {
      if (!files) return;
      for (const f of Array.from(files)) {
        if (!f.type.startsWith("image/")) continue;
        const ext = f.name.split(".").pop() ?? f.type.split("/")[1] ?? "png";
        await attachImage(entry.id, f, ext);
      }
    },
    [entry.id],
  );

  const handlePaste = useCallback(
    async (e: ReactClipboardEvent<HTMLDivElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const blobs: { blob: Blob; ext: string }[] = [];
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (blob) {
            const ext = it.type.split("/").pop() ?? "png";
            blobs.push({ blob, ext });
          }
        }
      }
      if (blobs.length === 0) return;
      e.preventDefault();
      for (const { blob, ext } of blobs) {
        await attachImage(entry.id, blob, ext);
      }
    },
    [entry.id],
  );

  return (
    <Field
      label="Images"
      hint={
        entry.images.length ? (
          <span className="k-num">{entry.images.length}</span>
        ) : null
      }
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
        onPaste={handlePaste}
        tabIndex={0}
        aria-label="Images. Paste or drop images here."
        data-drag-over={dragOver ? "" : undefined}
        className="nb-images"
      >
        {entry.images.map((img) => (
          <ImageThumb key={img.id} entry={entry} image={img} />
        ))}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="nb-thumb-add"
          aria-label="Add image"
          title="Add image"
        >
          <ImagePlus />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void handleFiles(e.target.files);
            // Allow re-selecting the same file later.
            e.target.value = "";
          }}
        />
      </div>
      <span className="nb-hint">
        Paste or drop images here. The first image is the entry’s avatar.
      </span>
    </Field>
  );
}

function ImageThumb({
  entry,
  image,
}: {
  entry: NotebookEntry;
  image: NotebookImage;
}) {
  const url = useImageUrl(image);
  return (
    <div className="nb-thumb">
      {url ? <img src={url} alt="" draggable={false} /> : null}
      <button
        type="button"
        onClick={() => void detachImage(entry.id, image.id)}
        className="nb-thumb-remove"
        aria-label="Remove image"
        title="Remove image"
      >
        <X />
      </button>
    </div>
  );
}
