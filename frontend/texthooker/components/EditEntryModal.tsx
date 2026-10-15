/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ReactNode,
} from "react";
import { Check, ImagePlus, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  Bar,
  BarSpacer,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  IconButton,
  Input,
  isComposing,
  Switch,
  Textarea,
} from "@kit";
import {
  addNote,
  attachImage,
  computeMentions,
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
import { DeleteEntryDialog } from "./EntryActionsMenu";
import { NotebookHero } from "./NotebookHero";
import {
  KIND_META,
  entryReading,
  entryTitle,
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
  /** The pane's width, and the handle that resizes it. */
  paneWidth?: number;
  resizeHandle?: ReactNode;
}

export function EditEntryModal({
  entryId,
  onClose,
  presentation = "dialog",
  paneWidth,
  resizeHandle,
}: Props) {
  const entry = useNotebookEntry(entryId ?? "");
  const open = entryId !== null && entry !== undefined;
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => setConfirmOpen(false), [entryId]);

  const title = entry ? entryTitle(entry) : "";
  const reading = entry ? entryReading(entry) : "";

  const confirm = (
    <DeleteEntryDialog
      entry={confirmOpen && entry ? entry : null}
      onOpenChange={setConfirmOpen}
      onDeleted={onClose}
    />
  );

  if (presentation === "pane") {
    if (!open || !entry) return null;
    return (
      <aside
        className="nb-editor"
        aria-label={`Edit ${title}`}
        style={{ width: paneWidth }}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !isComposing(event) &&
            !confirmOpen &&
            !event.defaultPrevented
          ) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <EditorHero
          entry={entry}
          title={title}
          reading={reading}
          onClose={onClose}
        />
        <div className="nb-editor-body">
          <EntryForm key={entry.id} entry={entry} />
        </div>
        <Bar position="bottom" className="nb-editor-foot">
          <Saved entry={entry} />
          <BarSpacer />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 />
            Delete
          </Button>
        </Bar>
        {confirm}
        {resizeHandle}
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

/** Edits save as they're typed; the pane's foot says when the last one did, with the mentions. */
function Saved({ entry }: { entry: NotebookEntry }) {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const opened = useRef(entry.id);
  const first = useRef(entry);
  useEffect(() => {
    // A different entry, or the same one as it was opened: nothing saved yet.
    if (opened.current !== entry.id) {
      opened.current = entry.id;
      first.current = entry;
      setSavedAt(null);
    } else if (entry !== first.current) {
      setSavedAt(Date.now());
      setNow(Date.now());
    }
  }, [entry]);
  useEffect(() => {
    if (savedAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [savedAt]);
  if (savedAt === null) return <Mentions entry={entry} />;
  const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
  return (
    <span className="nb-saved k-num" role="status">
      <Check />
      {seconds < 5
        ? "Saved"
        : seconds < 60
          ? `Saved ${Math.floor(seconds / 5) * 5}s ago`
          : `Saved ${Math.round(seconds / 60)} min ago`}
      <span className="nb-saved-sep" aria-hidden>
        ·
      </span>
      <Mentions entry={entry} />
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
            // A 、 typed mid-conversion splits when the IME commits it.
            if (
              ALIAS_SPLIT.test(next) &&
              !(e.nativeEvent as InputEvent).isComposing
            )
              commit(next);
            else setDraft(next);
          }}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
            } else if (e.key === "Backspace" && !draft && value.length > 0) {
              e.preventDefault();
              onChange(value.slice(0, -1));
            }
          }}
          onCompositionEnd={(e) => {
            if (ALIAS_SPLIT.test(e.currentTarget.value))
              commit(e.currentTarget.value);
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
            if (isComposing(e)) return;
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
            if (isComposing(e)) return;
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

/** The pane's header: the entry's picture as a hero, name in its lower third, close at top right. */
function EditorHero({
  entry,
  title,
  reading,
  onClose,
}: {
  entry: NotebookEntry;
  title: string;
  reading: string;
  onClose: () => void;
}) {
  const imageUrl = useImageUrl(entry.images[0]);
  return (
    <NotebookHero
      size="editor"
      imageUrl={imageUrl}
      kind={entry.kind}
      name={title}
      reading={reading || undefined}
      caption={KIND_META[entry.kind].one}
      actions={
        <IconButton label="Close editor" size="sm" onClick={onClose}>
          <X />
        </IconButton>
      }
    />
  );
}
