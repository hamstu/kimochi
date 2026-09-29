/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ImagePlus, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@texthooker/components/ui/dialog";
import { Button } from "@texthooker/components/ui/button";
import { Input } from "@texthooker/components/ui/input";
import { Switch } from "@texthooker/components/ui/switch";
import {
  addNote,
  attachImage,
  computeMentions,
  deleteEntry,
  deleteNote,
  detachImage,
  readImageAsObjectURL,
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

interface Props {
  /** Entry to edit, or null when closed. */
  entryId: string | null;
  onClose: () => void;
}

const KIND_TITLE = {
  person: "person",
  place: "place",
  thing: "thing",
} as const;

const inputClass =
  "rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-(--color-text) outline-none focus:border-(--color-accent)";
const textInputClass = `${inputClass} w-full`;
const textareaClass = `${inputClass} w-full min-h-[3.75rem] resize-y leading-snug`;

function Field({
  label,
  children,
  stacked,
}: {
  label: string;
  children: React.ReactNode;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="text-xs">
        <label className="block text-(--color-text) mb-1">{label}</label>
        {children}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
      <label className="text-(--color-text) shrink-0">{label}</label>
      <div className="flex items-center justify-end gap-2 flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}

export function EditEntryModal({ entryId, onClose }: Props) {
  const entry = useNotebookEntry(entryId ?? "");
  const open = entryId !== null && entry !== undefined;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="left-1/2 right-auto top-1/2 bottom-auto -translate-x-1/2 -translate-y-1/2 w-[28.75rem] max-w-[calc(100vw-48px)] max-h-[85vh] border border-(--color-border) rounded-lg shadow-[var(--shadow-pop)]"
        aria-describedby={undefined}
      >
        {entry ? (
          <>
            <div className="flex items-center justify-between mb-3">
              <DialogTitle className="text-sm font-semibold">
                Edit {KIND_TITLE[entry.kind]}
              </DialogTitle>
              <DialogClose asChild>
                <Button variant="ghost" size="icon" aria-label="Close">
                  <X className="h-4 w-4" />
                </Button>
              </DialogClose>
            </div>
            <div className="space-y-2.5">
              {entry.kind === "person" ? (
                <PersonFields entry={entry} />
              ) : (
                <PlaceThingFields entry={entry} />
              )}
              <CommonFields entry={entry} />
              <NotesSection entry={entry} />
              <ImageStrip entry={entry} />
              <EntryFooter entry={entry} onDeleted={onClose} />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PersonFields({ entry }: { entry: PersonEntry }) {
  const commitPatch = (patch: Partial<PersonEntry>) =>
    void updateEntry(entry.id, patch);

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Field label="姓 (family)" stacked>
          <Input
            className={textInputClass}
            value={entry.family}
            onChange={(e) => commitPatch({ family: e.target.value })}
            spellCheck={false}
            placeholder="田中"
          />
        </Field>
        <Field label="名 (given)" stacked>
          <Input
            className={textInputClass}
            value={entry.given}
            onChange={(e) => commitPatch({ given: e.target.value })}
            spellCheck={false}
            placeholder="太郎"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="姓 reading" stacked>
          <Input
            className={textInputClass}
            value={entry.familyReading ?? ""}
            onChange={(e) =>
              commitPatch({ familyReading: e.target.value || undefined })
            }
            spellCheck={false}
            placeholder="たなか"
          />
        </Field>
        <Field label="名 reading" stacked>
          <Input
            className={textInputClass}
            value={entry.givenReading ?? ""}
            onChange={(e) =>
              commitPatch({ givenReading: e.target.value || undefined })
            }
            spellCheck={false}
            placeholder="たろう"
          />
        </Field>
      </div>
      <Field label="Match given alone">
        <Switch
          checked={entry.matchGivenAlone}
          onCheckedChange={(v) => commitPatch({ matchGivenAlone: v })}
        />
      </Field>
      <AliasesField
        value={entry.aliases}
        onChange={(aliases) => commitPatch({ aliases })}
      />
    </>
  );
}

function PlaceThingFields({ entry }: { entry: PlaceOrThingEntry }) {
  const commitPatch = (patch: Partial<PlaceOrThingEntry>) =>
    void updateEntry(entry.id, patch);

  return (
    <>
      <Field label="Name" stacked>
        <Input
          className={textInputClass}
          value={entry.name}
          onChange={(e) => commitPatch({ name: e.target.value })}
          spellCheck={false}
          placeholder={entry.kind === "place" ? "東京" : "天使の指輪"}
        />
      </Field>
      <Field label="Reading" stacked>
        <Input
          className={textInputClass}
          value={entry.reading ?? ""}
          onChange={(e) =>
            commitPatch({ reading: e.target.value || undefined })
          }
          spellCheck={false}
        />
      </Field>
      <AliasesField
        value={entry.aliases}
        onChange={(aliases) => commitPatch({ aliases })}
      />
    </>
  );
}

function AliasesField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join(", "));
  useEffect(() => setDraft(value.join(", ")), [value]);
  return (
    <Field label="Aliases" stacked>
      <Input
        className={textInputClass}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const parsed = draft
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (
            parsed.length !== value.length ||
            parsed.some((p, i) => p !== value[i])
          ) {
            onChange(parsed);
          }
        }}
        placeholder="comma, separated"
        spellCheck={false}
      />
    </Field>
  );
}

function CommonFields({ entry }: { entry: NotebookEntry }) {
  return (
    <>
      <Field label="Description" stacked>
        <textarea
          className={textareaClass}
          value={entry.description}
          onChange={(e) =>
            void updateEntry(entry.id, { description: e.target.value })
          }
          spellCheck={false}
        />
      </Field>
      <Field label="Match this entry">
        <Switch
          checked={entry.matchEnabled}
          onCheckedChange={(v) =>
            void updateEntry(entry.id, { matchEnabled: v })
          }
        />
      </Field>
    </>
  );
}

/* ── Notes ─────────────────────────────────────────────────────────────── */

function NotesSection({ entry }: { entry: NotebookEntry }) {
  const [draft, setDraft] = useState("");

  const commitDraft = () => {
    const t = draft.trim();
    if (!t) return;
    addNote(entry.id, t);
    setDraft("");
  };

  const notes = entry.notes ?? [];

  return (
    <Field label="Notes" stacked>
      <div className="space-y-1">
        {notes.map((note) => (
          <NoteRow key={note.id} entryId={entry.id} note={note} />
        ))}
        <div className="flex items-center gap-1.5">
          <Input
            className={textInputClass}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
              }
            }}
            placeholder="Add a quick note…"
            spellCheck={false}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={commitDraft}
            disabled={!draft.trim()}
            title="Add note"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
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
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          className={textInputClass}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(note.text);
              setEditing(false);
            }
          }}
          onBlur={commit}
          spellCheck={false}
        />
        <Button
          variant="ghost"
          size="icon"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
          title="Save note"
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-1.5 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1">
      <span className="flex-1 min-w-0 text-xs leading-snug text-(--color-text) break-words whitespace-pre-wrap">
        {note.text}
      </span>
      <button
        type="button"
        onClick={() => {
          setDraft(note.text);
          setEditing(true);
        }}
        className="shrink-0 mt-0.5 text-(--color-text-muted) opacity-0 group-hover:opacity-100 hover:text-(--color-accent)"
        title="Edit note"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => deleteNote(entryId, note.id)}
        className="shrink-0 mt-0.5 text-(--color-text-muted) opacity-0 group-hover:opacity-100 hover:text-(--color-danger)"
        title="Delete note"
      >
        <X className="h-3 w-3" />
      </button>
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
    async (e: React.ClipboardEvent<HTMLDivElement>) => {
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
    <Field label="Images" stacked>
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
        className={`flex flex-wrap gap-1.5 rounded-md border border-dashed p-1.5 ${
          dragOver
            ? "border-(--color-accent) bg-(--color-accent-soft)"
            : "border-(--color-border)"
        }`}
      >
        {entry.images.map((img) => (
          <ImageThumb key={img.id} entry={entry} image={img} />
        ))}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex h-12 w-12 items-center justify-center rounded border border-dashed border-(--color-border) text-(--color-text-muted) hover:border-(--color-accent) hover:text-(--color-accent)"
          title="Add image"
        >
          <ImagePlus className="h-4 w-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files);
            // Allow re-selecting the same file later.
            e.target.value = "";
          }}
        />
      </div>
      <div className="mt-1 text-[0.625rem] text-(--color-text-muted)">
        Paste or drop images here. First image becomes the chip avatar.
      </div>
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
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let u: string | null = null;
    void readImageAsObjectURL(image).then((next) => {
      if (revoked) {
        URL.revokeObjectURL(next);
        return;
      }
      u = next;
      setUrl(next);
    });
    return () => {
      revoked = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [image]);

  return (
    <div className="relative h-12 w-12 overflow-hidden rounded border border-(--color-border) bg-(--color-bg)">
      {url ? (
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : null}
      <button
        type="button"
        onClick={() => void detachImage(entry.id, image.id)}
        className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/50 text-white hover:bg-(--color-danger)"
        title="Remove image"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </div>
  );
}

function EntryFooter({
  entry,
  onDeleted,
}: {
  entry: NotebookEntry;
  onDeleted: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [mentionCount, setMentionCount] = useState<number | null>(null);

  useEffect(() => {
    setMentionCount(computeMentions(entry.id, snapshotLines()).length);
  }, [entry.id, entry.matchEnabled, entry]);

  return (
    <div className="flex items-center justify-between pt-1 text-[0.6875rem]">
      <span className="text-(--color-text-muted)">
        {mentionCount === null
          ? ""
          : mentionCount === 0
            ? "No mentions in this session"
            : `${mentionCount} mention${mentionCount === 1 ? "" : "s"}`}
      </span>
      {armed ? (
        <span className="inline-flex items-center gap-1">
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              void deleteEntry(entry.id);
              onDeleted();
            }}
          >
            Confirm delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setArmed(true)}
          title="Delete entry"
        >
          <Trash2 className="h-3 w-3" />
          Delete
        </Button>
      )}
    </div>
  );
}
