/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Download, Loader2, Search, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@texthooker/components/ui/dialog";
import { Button } from "@texthooker/components/ui/button";
import { Input } from "@texthooker/components/ui/input";
import {
  bestJapaneseTitle,
  getVndbCharactersForVn,
  romanizedTitle,
  searchVndbVns,
  type VndbCharacter,
  type VndbVn,
} from "@texthooker/lib/vndb";
import {
  importVndbCharacter,
  type ImportResult,
} from "@texthooker/lib/vndbImport";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
type Stage = "pick-vn" | "confirm" | "done";

export function VndbImportDialog({ open, onOpenChange }: Props) {
  const [stage, setStage] = useState<Stage>("pick-vn");
  const [query, setQuery] = useState("");
  const [vnResults, setVnResults] = useState<VndbVn[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  // Stage: confirm
  const [chosenVn, setChosenVn] = useState<VndbVn | null>(null);
  const [chars, setChars] = useState<VndbCharacter[]>([]);
  const [loadingChars, setLoadingChars] = useState(false);
  const [charsErr, setCharsErr] = useState<string | null>(null);

  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [importResults, setImportResults] = useState<ImportResult[] | null>(
    null,
  );
  const reqSeq = useRef(0);
  const charReqSeq = useRef(0);

  // Reset everything on close.
  useEffect(() => {
    if (!open) {
      setStage("pick-vn");
      setQuery("");
      setVnResults([]);
      setSearchErr(null);
      setSearching(false);
      setChosenVn(null);
      setChars([]);
      setLoadingChars(false);
      setCharsErr(null);
      setImporting(false);
      setProgress({ done: 0, total: 0 });
      setImportResults(null);
    }
  }, [open]);

  // Debounced VN search.
  useEffect(() => {
    if (stage !== "pick-vn") return;
    const trimmed = query.trim();
    if (!trimmed) {
      setVnResults([]);
      setSearching(false);
      setSearchErr(null);
      return;
    }
    const mySeq = ++reqSeq.current;
    setSearching(true);
    setSearchErr(null);
    const timer = setTimeout(async () => {
      try {
        const res = await searchVndbVns(trimmed);
        if (mySeq !== reqSeq.current) return;
        setVnResults(res);
      } catch (err) {
        if (mySeq !== reqSeq.current) return;
        setSearchErr(String(err));
        setVnResults([]);
      } finally {
        if (mySeq === reqSeq.current) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, stage]);

  const handlePickVn = async (vn: VndbVn) => {
    setChosenVn(vn);
    setStage("confirm");
    setChars([]);
    setCharsErr(null);
    setLoadingChars(true);
    const mySeq = ++charReqSeq.current;
    try {
      const res = await getVndbCharactersForVn(vn.id);
      if (mySeq !== charReqSeq.current) return;
      setChars(res);
    } catch (err) {
      if (mySeq !== charReqSeq.current) return;
      setCharsErr(String(err));
    } finally {
      if (mySeq === charReqSeq.current) setLoadingChars(false);
    }
  };

  const handleBack = () => {
    if (importing) return;
    setStage("pick-vn");
    setChosenVn(null);
    setChars([]);
    setCharsErr(null);
    charReqSeq.current++;
  };

  const handleImport = async () => {
    if (chars.length === 0) return;
    setImporting(true);
    setProgress({ done: 0, total: chars.length });
    const out: ImportResult[] = [];
    for (let i = 0; i < chars.length; i++) {
      try {
        out.push(await importVndbCharacter(chars[i]));
      } catch (err) {
        console.warn("[vndb import] failed for", chars[i].id, err);
      }
      setProgress({ done: i + 1, total: chars.length });
    }
    setImportResults(out);
    setImporting(false);
    setStage("done");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="left-1/2 right-auto top-1/2 bottom-auto -translate-x-1/2 -translate-y-1/2 w-[35rem] max-w-[calc(100vw-48px)] max-h-[80vh] border border-(--color-border) rounded-lg shadow-[var(--shadow-pop)]"
        onInteractOutside={(e) => {
          if (importing) e.preventDefault();
        }}
        aria-describedby={undefined}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {stage === "confirm" && !importing ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleBack}
                title="Back to search"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            ) : null}
            <DialogTitle className="text-sm font-semibold">
              {stage === "pick-vn"
                ? "Import characters from VNDB"
                : stage === "confirm"
                  ? "Confirm import"
                  : "Import complete"}
            </DialogTitle>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </DialogClose>
        </div>

        {stage === "pick-vn" ? (
          <PickVnStage
            query={query}
            setQuery={setQuery}
            results={vnResults}
            searching={searching}
            searchErr={searchErr}
            onPick={handlePickVn}
          />
        ) : stage === "confirm" && chosenVn ? (
          <ConfirmStage
            vn={chosenVn}
            chars={chars}
            loading={loadingChars}
            error={charsErr}
            importing={importing}
            progress={progress}
            onImport={handleImport}
            onBack={handleBack}
          />
        ) : stage === "done" && importResults ? (
          <ImportSummary
            results={importResults}
            onDone={() => onOpenChange(false)}
            onSearchAgain={() => {
              setStage("pick-vn");
              setChosenVn(null);
              setChars([]);
              setImportResults(null);
              setProgress({ done: 0, total: 0 });
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ── Stage: pick a VN ──────────────────────────────────────────────────── */

function PickVnStage({
  query,
  setQuery,
  results,
  searching,
  searchErr,
  onPick,
}: {
  query: string;
  setQuery: (s: string) => void;
  results: VndbVn[];
  searching: boolean;
  searchErr: string | null;
  onPick: (vn: VndbVn) => void;
}) {
  return (
    <>
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-(--color-text-muted)" />
        <Input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search VNDB for a visual novel (English or 日本語)…"
          className="w-full rounded-md border border-(--color-border) bg-(--color-bg-elev) pl-7 pr-2 py-1.5 text-xs text-(--color-text) outline-none focus:border-(--color-accent)"
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-[0.6875rem] text-(--color-text-muted)">
        <span>
          {searching
            ? "Searching…"
            : searchErr
              ? "Search failed"
              : results.length > 0
                ? `${results.length} result${results.length === 1 ? "" : "s"}`
                : query
                  ? "No matching visual novels"
                  : "Type to search visual novels"}
        </span>
        {searchErr ? (
          <span className="text-(--color-danger)">{searchErr}</span>
        ) : null}
      </div>

      <div className="mt-2 max-h-[55vh] overflow-y-auto rounded-md border border-(--color-border) bg-(--color-bg-elev)/50">
        {results.length === 0 ? (
          <div className="p-4 text-center text-[0.6875rem] text-(--color-text-muted) italic">
            {searching ? (
              <Loader2 className="mx-auto h-4 w-4 animate-spin opacity-60" />
            ) : query ? (
              "No matches"
            ) : (
              "Results will appear here"
            )}
          </div>
        ) : (
          <ul className="divide-y divide-(--color-border)">
            {results.map((vn) => (
              <VnRow key={vn.id} vn={vn} onPick={() => onPick(vn)} />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <DialogClose asChild>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
        </DialogClose>
      </div>
    </>
  );
}

function VnRow({ vn, onPick }: { vn: VndbVn; onPick: () => void }) {
  const primary = bestJapaneseTitle(vn);
  const secondary = primary !== romanizedTitle(vn) ? romanizedTitle(vn) : null;
  const safeImage = vn.image && vn.image.sexual < 1 ? vn.image : null;

  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-(--color-bg-elev-2)"
      >
        {safeImage ? (
          <img
            src={safeImage.url}
            alt=""
            className="h-16 w-12 shrink-0 rounded-md object-cover border border-(--color-border)"
            draggable={false}
          />
        ) : (
          <div className="h-16 w-12 shrink-0 rounded-md border border-(--color-border) bg-(--color-bg) flex items-center justify-center text-[0.625rem] text-(--color-text-muted)">
            {vn.image ? "NSFW" : "—"}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div
            className="text-xs font-medium text-(--color-text) truncate"
            translate="no"
            lang="ja"
          >
            {primary}
          </div>
          {secondary ? (
            <div className="text-[0.6875rem] text-(--color-text-dim) truncate">
              {secondary}
            </div>
          ) : null}
          {vn.released ? (
            <div className="text-[0.625rem] text-(--color-text-muted) mt-0.5">
              {vn.released}
            </div>
          ) : null}
        </div>
      </button>
    </li>
  );
}

/* ── Stage: confirm + import ───────────────────────────────────────────── */

function ConfirmStage({
  vn,
  chars,
  loading,
  error,
  importing,
  progress,
  onImport,
  onBack,
}: {
  vn: VndbVn;
  chars: VndbCharacter[];
  loading: boolean;
  error: string | null;
  importing: boolean;
  progress: { done: number; total: number };
  onImport: () => void;
  onBack: () => void;
}) {
  const counts = useMemo(() => {
    const c = { main: 0, primary: 0, side: 0, appears: 0 };
    for (const ch of chars) {
      const role = ch.vns?.find((v) => v.id === vn.id)?.role;
      if (role && role in c) (c as Record<string, number>)[role] += 1;
    }
    return c;
  }, [chars, vn.id]);

  const primaryTitle = bestJapaneseTitle(vn);
  const secondaryTitle =
    primaryTitle !== romanizedTitle(vn) ? romanizedTitle(vn) : null;
  const safeImage = vn.image && vn.image.sexual < 1 ? vn.image : null;

  return (
    <>
      <div className="flex items-start gap-3 rounded-md border border-(--color-border) bg-(--color-bg-elev) p-2.5">
        {safeImage ? (
          <img
            src={safeImage.url}
            alt=""
            className="h-16 w-12 shrink-0 rounded-md object-cover border border-(--color-border)"
            draggable={false}
          />
        ) : (
          <div className="h-16 w-12 shrink-0 rounded-md border border-(--color-border) bg-(--color-bg) flex items-center justify-center text-[0.625rem] text-(--color-text-muted)">
            {vn.image ? "NSFW" : "—"}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div
            className="text-xs font-medium text-(--color-text) truncate"
            translate="no"
            lang="ja"
          >
            {primaryTitle}
          </div>
          {secondaryTitle ? (
            <div className="text-[0.6875rem] text-(--color-text-dim) truncate">
              {secondaryTitle}
            </div>
          ) : null}
          {vn.released ? (
            <div className="text-[0.625rem] text-(--color-text-muted) mt-0.5">
              Released {vn.released}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-[0.6875rem] text-(--color-text-muted)">
        {loading ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading characters…
          </span>
        ) : error ? (
          <span className="text-(--color-danger)">{error}</span>
        ) : (
          <span>
            {chars.length} character{chars.length === 1 ? "" : "s"}
            {chars.length > 0
              ? `  ·  ${counts.main}/${counts.primary}/${counts.side}/${counts.appears} main/primary/side/appears`
              : ""}
          </span>
        )}
      </div>

      <div className="mt-2 max-h-[45vh] overflow-y-auto rounded-md border border-(--color-border) bg-(--color-bg-elev)/50">
        {loading ? (
          <div className="p-6 text-center">
            <Loader2 className="mx-auto h-5 w-5 animate-spin opacity-60" />
          </div>
        ) : chars.length === 0 && !error ? (
          <div className="p-4 text-center text-[0.6875rem] text-(--color-text-muted) italic">
            VNDB has no character entries for this title.
          </div>
        ) : (
          <ul className="divide-y divide-(--color-border)">
            {chars.map((c) => (
              <CharRow key={c.id} char={c} vnId={vn.id} />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="text-[0.6875rem] text-(--color-text-muted)">
          {importing
            ? `Importing… ${progress.done} / ${progress.total}`
            : "Re-importing is safe — existing characters are updated in place."}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            disabled={importing}
          >
            Back
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={loading || importing || chars.length === 0}
            onClick={onImport}
          >
            {importing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            Import {chars.length || ""} character
            {chars.length === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    </>
  );
}

function CharRow({ char, vnId }: { char: VndbCharacter; vnId: string }) {
  const primaryName = char.original?.trim() || char.name;
  const secondary =
    char.original?.trim() && char.name !== char.original ? char.name : null;
  const role = char.vns?.find((v) => v.id === vnId)?.role;
  const safeImage = char.image && char.image.sexual < 1 ? char.image : null;

  return (
    <li className="flex items-start gap-3 px-3 py-2">
      {safeImage ? (
        <img
          src={safeImage.url}
          alt=""
          className="h-12 w-12 shrink-0 rounded-md object-cover border border-(--color-border)"
          draggable={false}
        />
      ) : (
        <div className="h-12 w-12 shrink-0 rounded-md border border-(--color-border) bg-(--color-bg) flex items-center justify-center text-[0.625rem] text-(--color-text-muted)">
          {char.image ? "NSFW" : "—"}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div
          className="text-xs font-medium text-(--color-text) truncate"
          translate="no"
          lang="ja"
        >
          {primaryName}
        </div>
        {secondary ? (
          <div className="text-[0.6875rem] text-(--color-text-dim) truncate">
            {secondary}
          </div>
        ) : null}
        {role ? (
          <div className="text-[0.625rem] text-(--color-text-muted) mt-0.5 uppercase tracking-wider">
            {role}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/* ── Stage: done summary ───────────────────────────────────────────────── */

function ImportSummary({
  results,
  onDone,
  onSearchAgain,
}: {
  results: ImportResult[];
  onDone: () => void;
  onSearchAgain: () => void;
}) {
  const created = results.filter((r) => r.status === "created").length;
  const updated = results.filter((r) => r.status === "updated").length;
  const unchanged = results.filter((r) => r.status === "unchanged").length;
  const imagesAttached = results.filter((r) => r.imageAttached).length;

  return (
    <div className="text-xs text-(--color-text)">
      <div className="rounded-md border border-(--color-border) bg-(--color-bg-elev) p-3">
        <div className="font-medium mb-2">Done — imported {results.length}</div>
        <ul className="space-y-1 text-[0.6875rem] text-(--color-text-muted)">
          <li>{created} created</li>
          <li>{updated} updated in place</li>
          <li>{unchanged} already up to date</li>
          <li>
            {imagesAttached} image{imagesAttached === 1 ? "" : "s"} attached
          </li>
        </ul>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onSearchAgain}>
          Import another
        </Button>
        <Button variant="default" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
