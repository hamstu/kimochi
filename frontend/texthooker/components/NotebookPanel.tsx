/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useMemo, useState } from "react";
import { Download, Pencil, Plus } from "lucide-react";
import { VndbImportDialog } from "./VndbImportDialog";
import { Button } from "@texthooker/components/ui/button";
import { Input } from "@texthooker/components/ui/input";
import {
  createPerson,
  createPlace,
  createThing,
  getNotebook,
  readImageAsObjectURL,
  subscribeNotebook,
} from "@texthooker/lib/notebook";
import { openEditModal } from "@texthooker/lib/editModal";
import {
  getActiveSession,
  renameSession,
  subscribeSessions,
  updateSessionDescription,
} from "@texthooker/lib/sessions";
import type {
  NotebookEntry,
  NotebookFile,
  PersonEntry,
  PlaceOrThingEntry,
  SessionMeta,
} from "@texthooker/lib/types";

function Group({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-(--color-border) pt-3 mb-4 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-(--color-text-dim)">
          {title}
        </h2>
        {trailing}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

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

const inputClass =
  "rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-(--color-text) outline-none focus:border-(--color-accent)";
const textInputClass = `${inputClass} w-full`;
const textareaClass = `${inputClass} w-full min-h-[3.75rem] resize-y leading-snug`;

export function NotebookPanel() {
  const [nb, setNb] = useState<NotebookFile>(() => getNotebook());
  const [vndbOpen, setVndbOpen] = useState(false);
  const [session, setSession] = useState<SessionMeta | null>(() => {
    try {
      return getActiveSession();
    } catch {
      return null;
    }
  });

  useEffect(() => {
    return subscribeNotebook((next) => setNb(next));
  }, []);

  useEffect(() => {
    return subscribeSessions((m) => {
      const a = m.sessions.find((s) => s.id === m.activeId);
      if (a) setSession(a);
    });
  }, []);

  const people = useMemo(
    () => nb.entries.filter((e): e is PersonEntry => e.kind === "person"),
    [nb],
  );
  const places = useMemo(
    () => nb.entries.filter((e): e is PlaceOrThingEntry => e.kind === "place"),
    [nb],
  );
  const things = useMemo(
    () => nb.entries.filter((e): e is PlaceOrThingEntry => e.kind === "thing"),
    [nb],
  );

  const addAndEdit = (create: () => Promise<NotebookEntry>) => {
    void create().then((entry) => openEditModal(entry.id));
  };

  return (
    <>
      <div className="reader-notebook">
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold">
              Characters, places & things
            </h2>
          </div>

          {session ? (
            <SessionGroup
              session={session}
              onOpenVndbImport={() => setVndbOpen(true)}
            />
          ) : null}

          <Group
            title="People"
            trailing={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addAndEdit(createPerson)}
                title="Add person"
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
            }
          >
            {people.length === 0 ? (
              <EmptyHint label="No people yet." />
            ) : (
              people.map((p) => <EntryListItem key={p.id} entry={p} />)
            )}
          </Group>

          <Group
            title="Places"
            trailing={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addAndEdit(createPlace)}
                title="Add place"
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
            }
          >
            {places.length === 0 ? (
              <EmptyHint label="No places yet." />
            ) : (
              places.map((p) => <EntryListItem key={p.id} entry={p} />)
            )}
          </Group>

          <Group
            title="Things"
            trailing={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addAndEdit(createThing)}
                title="Add thing"
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
            }
          >
            {things.length === 0 ? (
              <EmptyHint label="No things yet." />
            ) : (
              things.map((t) => <EntryListItem key={t.id} entry={t} />)
            )}
          </Group>
        </div>
      </div>
      <VndbImportDialog open={vndbOpen} onOpenChange={setVndbOpen} />
    </>
  );
}

function EmptyHint({ label }: { label: string }) {
  return (
    <div className="text-[0.6875rem] text-(--color-text-muted) italic">
      {label}
    </div>
  );
}

function SessionGroup({
  session,
  onOpenVndbImport,
}: {
  session: SessionMeta;
  onOpenVndbImport: () => void;
}) {
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
    <Group title="Session">
      <Field label="Name" stacked>
        <Input
          className={textInputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          spellCheck={false}
        />
      </Field>
      <div className="flex justify-start">
        <Button
          variant="default"
          size="sm"
          onClick={onOpenVndbImport}
          title="Import characters from VNDB"
        >
          <Download className="h-3 w-3" />
          Import from VNDB
        </Button>
      </div>
      <Field label="Description" stacked>
        <textarea
          className={textareaClass}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onBlur={commitDesc}
          spellCheck={false}
          placeholder="What is this session about?"
        />
      </Field>
    </Group>
  );
}

/* ── Entry list ────────────────────────────────────────────────────────── */

/** Name with per-part ruby (hiragana) when readings are available. */
function EntryName({ entry }: { entry: NotebookEntry }) {
  if (entry.kind === "person") {
    const fam = entry.family.trim();
    const giv = entry.given.trim();
    if (!fam && !giv) {
      return <span className="text-(--color-text-muted)">(new person)</span>;
    }
    return (
      <>
        {fam ? <RubyPart text={fam} reading={entry.familyReading} /> : null}
        {fam && giv ? " " : null}
        {giv ? <RubyPart text={giv} reading={entry.givenReading} /> : null}
      </>
    );
  }
  const name = entry.name.trim();
  if (!name) {
    return (
      <span className="text-(--color-text-muted)">(new {entry.kind})</span>
    );
  }
  return <RubyPart text={name} reading={entry.reading} />;
}

function RubyPart({ text, reading }: { text: string; reading?: string }) {
  const r = reading?.trim();
  if (!r || r === text) return <>{text}</>;
  return (
    <ruby>
      {text}
      <rt>{r}</rt>
    </ruby>
  );
}

function EntryListItem({ entry }: { entry: NotebookEntry }) {
  const snippet = entry.description.trim().replace(/\s+/g, " ");

  return (
    <div
      data-entry-id={entry.id}
      className="group flex items-center gap-2.5 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1.5"
    >
      <EntryAvatar entry={entry} />
      <button
        type="button"
        onClick={() => openEditModal(entry.id)}
        className="min-w-0 flex-1 text-left"
        title="Edit entry"
      >
        <div
          className="truncate text-[1rem] leading-[1.6] text-(--color-text)"
          style={{ fontFamily: "var(--font-jp)" }}
          translate="no"
          lang="ja"
        >
          <EntryName entry={entry} />
          {!entry.matchEnabled ? (
            <span className="ml-1.5 align-middle text-[0.625rem] font-sans text-(--color-text-muted)">
              muted
            </span>
          ) : null}
        </div>
        {snippet ? (
          <div className="truncate text-[0.6875rem] text-(--color-text-muted)">
            {snippet}
          </div>
        ) : null}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => openEditModal(entry.id)}
        title="Edit entry"
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function EntryAvatar({ entry }: { entry: NotebookEntry }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let u: string | null = null;
    const first = entry.images[0];
    if (!first) {
      setUrl(null);
      return;
    }
    void readImageAsObjectURL(first).then((next) => {
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
  }, [entry.images]);

  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full object-cover border border-(--color-border)"
        draggable={false}
      />
    );
  }
  return (
    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--color-accent-soft) text-[0.875rem] text-(--color-accent)">
      {entry.kind === "person" ? "人" : entry.kind === "place" ? "地" : "物"}
    </span>
  );
}
