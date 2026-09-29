/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  Download,
  ImageOff,
  Search,
  SearchX,
  UserRound,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogClose,
  DialogContent,
  EmptyState,
  IconButton,
  Input,
  Row,
  Spinner,
} from "@kit";
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
import "../notebook.css";

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

  const resetToSearch = () => {
    setStage("pick-vn");
    setChosenVn(null);
    setChars([]);
    setImportResults(null);
    setProgress({ done: 0, total: 0 });
  };

  const title =
    stage === "pick-vn"
      ? "Import characters from VNDB"
      : stage === "confirm"
        ? "Confirm import"
        : "Import complete";
  const description =
    stage === "pick-vn"
      ? "Pick the visual novel you are reading. Its characters become notebook entries."
      : stage === "confirm"
        ? "Re-importing is safe: existing characters are updated in place."
        : undefined;

  let footer: ReactNode;
  if (stage === "pick-vn") {
    footer = (
      <DialogClose asChild>
        <Button>Cancel</Button>
      </DialogClose>
    );
  } else if (stage === "confirm") {
    footer = (
      <>
        <span className="nb-vndb-foot-note">
          {importing ? `Importing ${progress.done} of ${progress.total}…` : ""}
        </span>
        <Button onClick={handleBack} disabled={importing}>
          Back
        </Button>
        <Button
          variant="primary"
          disabled={loadingChars || importing || chars.length === 0}
          onClick={handleImport}
        >
          {importing ? <Spinner label="Importing" /> : <Download />}
          {chars.length > 0
            ? `Import ${chars.length} character${chars.length === 1 ? "" : "s"}`
            : "Import"}
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button onClick={resetToSearch}>Import another</Button>
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="nb-vndb"
        title={title}
        description={description}
        footer={footer}
        onInteractOutside={(e) => {
          if (importing) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (importing) e.preventDefault();
        }}
      >
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
          />
        ) : stage === "done" && importResults ? (
          <ImportSummary results={importResults} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ── Shared bits ───────────────────────────────────────────────────────── */

type VndbImage = { url: string; sexual: number } | null;

function Cover({ image, round }: { image: VndbImage; round?: boolean }) {
  const safe = image && image.sexual < 1 ? image : null;
  return (
    <span
      className={round ? "nb-cover nb-cover-char" : "nb-cover"}
      title={image && !safe ? "Image hidden (NSFW)" : undefined}
    >
      {safe ? (
        <img src={safe.url} alt="" draggable={false} />
      ) : image ? (
        <ImageOff aria-label="Image hidden (NSFW)" />
      ) : round ? (
        <UserRound aria-hidden />
      ) : null}
    </span>
  );
}

function SkeletonRows({ count, round }: { count: number; round?: boolean }) {
  return (
    <div aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="nb-skel">
          <span
            className="nb-skel-block"
            style={round ? { height: "2.25rem", borderRadius: "999px" } : undefined}
          />
          <div>
            <span className="nb-skel-line" />
            <span className="nb-skel-line" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Arrow keys move between result rows; ArrowUp from the first row returns to search. */
function onRowsKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  onTop?: () => void,
) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button.k-row"),
  );
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (index === -1) return;
  event.preventDefault();
  if (event.key === "ArrowDown") rows[Math.min(rows.length - 1, index + 1)]?.focus();
  else if (index === 0) onTop?.();
  else rows[index - 1]?.focus();
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();

  return (
    <>
      <div className="nb-search">
        <Search />
        <Input
          ref={inputRef}
          autoFocus
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown") {
              const first = listRef.current?.querySelector<HTMLElement>("button.k-row");
              if (first) {
                e.preventDefault();
                first.focus();
              }
            } else if (e.key === "Enter" && results[0] && !searching) {
              e.preventDefault();
              onPick(results[0]);
            }
          }}
          placeholder="Title in English or 日本語"
          aria-label="Search VNDB"
        />
        {query ? (
          <span className="nb-search-end">
            <IconButton
              label="Clear search"
              size="sm"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <X />
            </IconButton>
          </span>
        ) : null}
      </div>

      <div className="nb-vndb-status" aria-live="polite">
        {searching ? (
          <>
            <Spinner label="Searching" />
            Searching VNDB…
          </>
        ) : searchErr ? (
          "Search failed"
        ) : results.length > 0 ? (
          <span className="k-num">
            {results.length} result{results.length === 1 ? "" : "s"}
          </span>
        ) : trimmed ? (
          "No matching visual novels"
        ) : (
          "Type to search visual novels"
        )}
      </div>

      {searchErr ? <Callout tone="danger">{searchErr}</Callout> : null}

      <div
        ref={listRef}
        className="nb-vndb-list"
        onKeyDown={(e) => onRowsKeyDown(e, () => inputRef.current?.focus())}
      >
        {results.length > 0 ? (
          results.map((vn) => <VnRow key={vn.id} vn={vn} onPick={() => onPick(vn)} />)
        ) : searching ? (
          <SkeletonRows count={4} />
        ) : trimmed && !searchErr ? (
          <EmptyState
            className="nb-vndb-empty"
            icon={<SearchX />}
            title={`No results for “${trimmed}”`}
          >
            Try the original Japanese title, or fewer words.
          </EmptyState>
        ) : !searchErr ? (
          <EmptyState
            className="nb-vndb-empty"
            icon={<Search />}
            title="Find your visual novel"
          >
            Results show the cover, title and release date. Pick one to review
            its characters before importing.
          </EmptyState>
        ) : null}
      </div>
    </>
  );
}

function VnRow({ vn, onPick }: { vn: VndbVn; onPick: () => void }) {
  const primary = bestJapaneseTitle(vn);
  const secondary = primary !== romanizedTitle(vn) ? romanizedTitle(vn) : null;

  return (
    <Row
      className="nb-vndb-row"
      icon={<Cover image={vn.image} />}
      onClick={onPick}
      trailing={<ChevronRight className="nb-vndb-chevron" aria-hidden />}
    >
      <span className="nb-vndb-title" lang="ja" translate="no">
        {primary}
      </span>
      {secondary ? <span className="nb-vndb-sub">{secondary}</span> : null}
      {vn.released ? <span className="nb-vndb-meta">{vn.released}</span> : null}
    </Row>
  );
}

/* ── Stage: confirm + import ───────────────────────────────────────────── */

const ROLE_LABEL: Record<string, string> = {
  main: "Protagonist",
  primary: "Main",
  side: "Side",
  appears: "Appears",
};

function ConfirmStage({
  vn,
  chars,
  loading,
  error,
}: {
  vn: VndbVn;
  chars: VndbCharacter[];
  loading: boolean;
  error: string | null;
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

  return (
    <>
      <div className="nb-vndb-head">
        <Cover image={vn.image} />
        <div>
          <span className="nb-vndb-title" lang="ja" translate="no">
            {primaryTitle}
          </span>
          {secondaryTitle ? (
            <span className="nb-vndb-sub">{secondaryTitle}</span>
          ) : null}
          {vn.released ? (
            <span className="nb-vndb-meta">Released {vn.released}</span>
          ) : null}
        </div>
      </div>

      <div className="nb-vndb-status" aria-live="polite">
        {loading ? (
          <>
            <Spinner label="Loading characters" />
            Loading characters…
          </>
        ) : error ? (
          "Could not load characters"
        ) : (
          <>
            <span className="k-num">
              {chars.length} character{chars.length === 1 ? "" : "s"}
            </span>
            {chars.length > 0
              ? (Object.keys(counts) as (keyof typeof counts)[])
                  .filter((role) => counts[role] > 0)
                  .map((role) => (
                    <Badge key={role}>
                      {ROLE_LABEL[role]} {counts[role]}
                    </Badge>
                  ))
              : null}
          </>
        )}
      </div>

      {error ? <Callout tone="danger">{error}</Callout> : null}

      <div className="nb-vndb-list" onKeyDown={(e) => onRowsKeyDown(e)}>
        {loading ? (
          <SkeletonRows count={5} round />
        ) : chars.length === 0 && !error ? (
          <EmptyState
            className="nb-vndb-empty"
            icon={<UserRound />}
            title="No characters listed"
          >
            VNDB has no character entries for this title.
          </EmptyState>
        ) : (
          chars.map((c) => <CharRow key={c.id} char={c} vnId={vn.id} />)
        )}
      </div>
    </>
  );
}

function CharRow({ char, vnId }: { char: VndbCharacter; vnId: string }) {
  const primaryName = char.original?.trim() || char.name;
  const secondary =
    char.original?.trim() && char.name !== char.original ? char.name : null;
  const role = char.vns?.find((v) => v.id === vnId)?.role;

  return (
    <div className="k-row nb-vndb-row nb-vndb-row-static" role="listitem">
      <Cover image={char.image} round />
      <span className="k-row-label">
        <span className="nb-vndb-title" lang="ja" translate="no">
          {primaryName}
        </span>
        {secondary ? <span className="nb-vndb-sub">{secondary}</span> : null}
      </span>
      {role ? (
        <Badge tone={role === "main" ? "accent" : "neutral"}>
          {ROLE_LABEL[role] ?? role}
        </Badge>
      ) : null}
    </div>
  );
}

/* ── Stage: done summary ───────────────────────────────────────────────── */

function ImportSummary({ results }: { results: ImportResult[] }) {
  const created = results.filter((r) => r.status === "created").length;
  const updated = results.filter((r) => r.status === "updated").length;
  const unchanged = results.filter((r) => r.status === "unchanged").length;
  const imagesAttached = results.filter((r) => r.imageAttached).length;

  const rows: [string, number][] = [
    ["Created", created],
    ["Updated in place", updated],
    ["Already up to date", unchanged],
    [`Image${imagesAttached === 1 ? "" : "s"} attached`, imagesAttached],
  ];

  return (
    <>
      <Callout>
        Imported{" "}
        <span className="k-num">
          {results.length} character{results.length === 1 ? "" : "s"}
        </span>{" "}
        into this session’s notebook.
      </Callout>
      <div className="nb-vndb-summary" role="list">
        {rows.map(([label, value]) => (
          <div
            key={label}
            role="listitem"
            className="k-row nb-vndb-row nb-vndb-row-static"
          >
            <span className="k-row-label">{label}</span>
            <span className="k-row-meta">{value}</span>
          </div>
        ))}
      </div>
    </>
  );
}
