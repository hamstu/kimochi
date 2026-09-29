/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { Button } from "@texthooker/components/ui/button";
import { Input } from "@texthooker/components/ui/input";
import { Switch } from "@texthooker/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@texthooker/components/ui/select";
import {
  listDecks,
  listModelFields,
  listModels,
  onAnkiStatus,
  probeAnki,
} from "@texthooker/lib/ankiconnect";
import { updateSettings } from "@texthooker/lib/settings";
import type {
  AnkiFieldMapping,
  AnkiStatus,
  Settings,
} from "@texthooker/lib/types";
import { YOMITAN_MARKERS } from "@texthooker/lib/types";
import {
  extractConfigFromCardFormat,
  findTermCardFormats,
  type CardFormatOption,
  type ImportedConfig,
} from "@texthooker/lib/yomitanImport";

interface Props {
  settings: Settings;
}

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
      <label className="text-(--color-text) shrink-0">{label}</label>
      <div className="flex items-center justify-end gap-2 flex-1 min-w-0">
        {children}
      </div>
      {hint ? (
        <div className="basis-full text-[0.625rem] text-(--color-text-muted) text-right">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function AnkiSetup({ settings }: Props) {
  const [urlDraft, setUrlDraft] = useState(settings.ankiConnectUrl);
  const [tagsDraft, setTagsDraft] = useState(settings.ankiTags.join(", "));
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [status, setStatus] = useState<AnkiStatus>("unknown");
  const [decks, setDecks] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelFields, setModelFields] = useState<string[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  // Yomitan-config import state
  const [importOptions, setImportOptions] = useState<CardFormatOption[]>([]);
  const [importIndex, setImportIndex] = useState(0);
  const [importPreview, setImportPreview] = useState<ImportedConfig | null>(
    null,
  );
  const [importError, setImportError] = useState<string | null>(null);

  const resetImport = () => {
    setImportOptions([]);
    setImportIndex(0);
    setImportPreview(null);
    setImportError(null);
  };

  const handleImportClick = async () => {
    resetImport();
    let picked: string | string[] | null;
    try {
      picked = await openDialog({
        title: "Import Yomitan settings",
        multiple: false,
        filters: [{ name: "Yomitan settings JSON", extensions: ["json"] }],
      });
    } catch (err) {
      setImportError(String(err));
      return;
    }
    if (!picked || typeof picked !== "string") return;
    let raw: string;
    try {
      raw = await readTextFile(picked);
    } catch (err) {
      setImportError(`Couldn't read file: ${err}`);
      return;
    }
    let options: CardFormatOption[];
    try {
      options = findTermCardFormats(raw);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
      return;
    }
    setImportOptions(options);
    setImportIndex(0);
    setImportPreview(extractConfigFromCardFormat(options[0]));
  };

  const handleImportSelectIndex = (idx: number) => {
    setImportIndex(idx);
    setImportPreview(extractConfigFromCardFormat(importOptions[idx]));
  };

  const handleImportConfirm = async () => {
    if (!importPreview) return;
    await updateSettings({
      ankiDeckName: importPreview.deckName,
      ankiModelName: importPreview.modelName,
      ankiFieldMappings: importPreview.fieldMappings,
      // Keep "super-texthooker" tag + merge in Yomitan's profile tags.
      ankiTags: Array.from(
        new Set(["super-texthooker", ...importPreview.tags]),
      ),
      // Clear cached model fields so we refetch for the new model.
      ankiModelFields: [],
    });
    resetImport();
    setRefreshTick((n) => n + 1);
  };

  useEffect(() => onAnkiStatus(setStatus), []);

  useEffect(() => {
    setUrlDraft(settings.ankiConnectUrl);
  }, [settings.ankiConnectUrl]);

  useEffect(() => {
    setTagsDraft(settings.ankiTags.join(", "));
  }, [settings.ankiTags]);

  // Load decks + models whenever the URL changes (or we hit Retry).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [d, m] = await Promise.all([
          listDecks(settings.ankiConnectUrl),
          listModels(settings.ankiConnectUrl),
        ]);
        if (cancelled) return;
        setDecks(d);
        setModels(m);
      } catch {
        if (cancelled) return;
        setDecks([]);
        setModels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.ankiConnectUrl, refreshTick]);

  // Load fields when the model changes; mirror into settings so the popover
  // can reach them without a round-trip to AnkiConnect on every send.
  useEffect(() => {
    let cancelled = false;
    if (!settings.ankiModelName) {
      setModelFields([]);
      if (settings.ankiModelFields.length > 0) {
        void updateSettings({ ankiModelFields: [] });
      }
      return;
    }
    void (async () => {
      try {
        const fs = await listModelFields(
          settings.ankiConnectUrl,
          settings.ankiModelName!,
        );
        if (cancelled) return;
        setModelFields(fs);
        if (fs.join("|") !== settings.ankiModelFields.join("|")) {
          void updateSettings({ ankiModelFields: fs });
        }
      } catch {
        if (cancelled) return;
        setModelFields([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ankiConnectUrl, settings.ankiModelName, refreshTick]);

  const handleTest = async () => {
    setProbeBusy(true);
    setProbeMsg(null);
    const r = await probeAnki(urlDraft.trim());
    setProbeBusy(false);
    if (r.ok) {
      setProbeMsg({ ok: true, text: `OK · ${r.latencyMs}ms` });
      setRefreshTick((n) => n + 1);
    } else {
      setProbeMsg({ ok: false, text: `Failed: ${r.error}` });
    }
  };

  const handleUrlBlur = async () => {
    const next = urlDraft.trim();
    if (next && next !== settings.ankiConnectUrl) {
      await updateSettings({ ankiConnectUrl: next });
      setProbeMsg(null);
    }
  };

  const handleTagsBlur = async () => {
    const parsed = tagsDraft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.join("|") !== settings.ankiTags.join("|")) {
      await updateSettings({ ankiTags: parsed });
    }
  };

  const setMapping = (ankiField: string, mapping: AnkiFieldMapping | null) => {
    const rest = settings.ankiFieldMappings.filter(
      (m) => m.ankiField !== ankiField,
    );
    const next = mapping ? [...rest, mapping] : rest;
    void updateSettings({ ankiFieldMappings: next });
  };

  const getMapping = (ankiField: string): AnkiFieldMapping | null => {
    return (
      settings.ankiFieldMappings.find((m) => m.ankiField === ankiField) ?? null
    );
  };

  /** Convert a mapping object → a single string the autocomplete displays.
      Sentinels: "" = unmapped, "(sentence)" = sentence-cloze-style. Plain
      strings that match a known marker are markers; anything else is literal. */
  const mappingToValue = (m: AnkiFieldMapping | null): string => {
    if (!m) return "";
    switch (m.mappingType) {
      case "empty":
        return "";
      case "sentence":
        return "(sentence)";
      case "marker":
        return m.marker ?? "";
      case "literal":
        return m.literal ?? "";
    }
  };

  const valueToMapping = (
    ankiField: string,
    value: string,
  ): AnkiFieldMapping | null => {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (trimmed === "(sentence)") {
      return { ankiField, mappingType: "sentence" };
    }
    if ((YOMITAN_MARKERS as readonly string[]).includes(trimmed)) {
      return { ankiField, mappingType: "marker", marker: trimmed };
    }
    return { ankiField, mappingType: "literal", literal: value };
  };

  const disconnected = status === "err";

  return (
    <div className="space-y-2.5">
      <Field label="AnkiConnect URL">
        <Input
          type="text"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={handleUrlBlur}
          placeholder="http://127.0.0.1:8765"
          className="w-full max-w-[12.5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs"
        />
      </Field>

      <div className="flex justify-end items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={handleTest}
          disabled={probeBusy}
        >
          {probeBusy ? "Testing…" : "Test"}
        </Button>
        {probeMsg ? (
          <span
            className={
              probeMsg.ok
                ? "text-[0.625rem] text-(--color-ok)"
                : "text-[0.625rem] text-(--color-danger)"
            }
          >
            {probeMsg.text}
          </span>
        ) : null}
      </div>

      <Field label="Enable mining" hint="Show + Add to Anki button in popover">
        <Switch
          checked={settings.ankiEnabled}
          onCheckedChange={(v) => updateSettings({ ankiEnabled: v })}
        />
      </Field>

      {disconnected ? (
        <div className="rounded-md border border-(--color-danger) bg-(--color-bg-elev-2) px-2.5 py-2 text-[0.6875rem] text-(--color-text)">
          Could not reach AnkiConnect. Make sure Anki is running with the
          AnkiConnect add-on installed.
          <div className="mt-1.5 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRefreshTick((n) => n + 1)}
            >
              Retry
            </Button>
          </div>
        </div>
      ) : null}

      <Field label="Deck">
        <Select
          value={settings.ankiDeckName ?? ""}
          onValueChange={(v) =>
            updateSettings({ ankiDeckName: v === "" ? null : v })
          }
          disabled={decks.length === 0}
        >
          <SelectTrigger className="w-[11.25rem]">
            <SelectValue placeholder="Select deck" />
          </SelectTrigger>
          <SelectContent>
            {decks.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Note type">
        <Select
          value={settings.ankiModelName ?? ""}
          onValueChange={(v) =>
            updateSettings({
              ankiModelName: v === "" ? null : v,
              ankiFieldMappings: [],
              ankiModelFields: [],
            })
          }
          disabled={models.length === 0}
        >
          <SelectTrigger className="w-[11.25rem]">
            <SelectValue placeholder="Select note type" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <div className="flex justify-end items-center gap-2">
        <Button variant="default" size="sm" onClick={handleImportClick}>
          Import from Yomitan…
        </Button>
      </div>

      {importError ? (
        <div className="rounded-md border border-(--color-danger) bg-(--color-bg-elev-2) px-2.5 py-2 text-[0.6875rem] text-(--color-text)">
          {importError}
          <div className="mt-1.5 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setImportError(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {importPreview ? (
        <div className="rounded-md border border-(--color-accent) bg-(--color-bg-elev-2) p-2.5 space-y-2">
          <div className="text-[0.625rem] uppercase tracking-wider text-(--color-text-dim)">
            Preview import
          </div>

          {importOptions.length > 1 ? (
            <div className="space-y-1">
              <div className="text-[0.625rem] text-(--color-text-muted)">
                Multiple Yomitan profiles found:
              </div>
              {importOptions.map((o, i) => (
                <label
                  key={i}
                  className="flex items-center gap-2 text-[0.6875rem] cursor-pointer"
                >
                  <input
                    type="radio"
                    name="yomitan-import-profile"
                    checked={importIndex === i}
                    onChange={() => handleImportSelectIndex(i)}
                  />
                  <span>
                    {o.profileName}{" "}
                    <span className="text-(--color-text-muted)">
                      ({o.cardFormat.model})
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          <div className="text-[0.6875rem] space-y-0.5">
            <div>
              <span className="text-(--color-text-dim)">Deck:</span>{" "}
              {importPreview.deckName}
            </div>
            <div>
              <span className="text-(--color-text-dim)">Note type:</span>{" "}
              {importPreview.modelName}
            </div>
            {importPreview.tags.length > 0 ? (
              <div>
                <span className="text-(--color-text-dim)">Tags:</span>{" "}
                {importPreview.tags.join(", ")}
              </div>
            ) : null}
          </div>

          <div className="text-[0.625rem] text-(--color-text-dim) uppercase tracking-wider">
            Field mappings ({importPreview.fieldMappings.length})
          </div>
          <div className="max-h-32 overflow-y-auto rounded border border-(--color-border) bg-(--color-bg-elev)">
            {importPreview.fieldMappings.length === 0 ? (
              <div className="px-2 py-1.5 text-[0.6875rem] text-(--color-text-muted) italic">
                No mappings detected.
              </div>
            ) : (
              <table className="w-full text-[0.6875rem]">
                <tbody>
                  {importPreview.fieldMappings.map((m) => (
                    <tr
                      key={m.ankiField}
                      className="border-b border-(--color-border) last:border-0"
                    >
                      <td className="px-2 py-0.5 text-(--color-text)">
                        {m.ankiField}
                      </td>
                      <td className="px-2 py-0.5 text-(--color-text-dim)">
                        {m.mappingType === "sentence"
                          ? "(sentence)"
                          : m.mappingType === "marker"
                            ? m.marker
                            : m.mappingType === "literal"
                              ? `"${m.literal ?? ""}"`
                              : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={resetImport}>
              Cancel
            </Button>
            <Button variant="default" size="sm" onClick={handleImportConfirm}>
              Apply
            </Button>
          </div>
        </div>
      ) : null}

      {modelFields.length > 0 ? (
        <div className="mt-1.5 rounded-md border border-(--color-border) bg-(--color-bg-elev) p-2">
          <div className="text-[0.625rem] uppercase tracking-wider text-(--color-text-dim) mb-1.5">
            Field mapping
          </div>
          <p className="text-[0.625rem] text-(--color-text-muted) mb-2">
            Type a Yomitan marker, <code>(sentence)</code>, or literal text.
          </p>
          <datalist id="anki-mapping-options">
            <option value="(sentence)" />
            {YOMITAN_MARKERS.map((mk) => (
              <option key={mk} value={mk} />
            ))}
          </datalist>
          <div className="space-y-1.5">
            {modelFields.map((f) => {
              const m = getMapping(f);
              const display = mappingToValue(m);
              return (
                <div
                  key={f}
                  className="flex items-center gap-2 text-[0.6875rem]"
                >
                  <div className="min-w-[6.25rem] shrink-0 truncate text-(--color-text-dim)">
                    {f}
                  </div>
                  <Input
                    type="text"
                    list="anki-mapping-options"
                    defaultValue={display}
                    placeholder="(unmapped)"
                    onBlur={(e) => {
                      const next = valueToMapping(f, e.target.value);
                      const before = mappingToValue(m);
                      if (e.target.value === before) return;
                      setMapping(f, next);
                    }}
                    className="flex-1 rounded-md border border-(--color-border) bg-(--color-bg-elev-2) px-2 py-1 text-[0.6875rem]"
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <Field label="Tags" hint="Comma-separated tags added to every card">
        <Input
          type="text"
          value={tagsDraft}
          onChange={(e) => setTagsDraft(e.target.value)}
          onBlur={handleTagsBlur}
          placeholder="super-texthooker"
          className="w-full max-w-[12.5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs"
        />
      </Field>
    </div>
  );
}
