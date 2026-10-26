/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import {
  Button,
  Callout,
  ChoiceGroup,
  Input,
  Select,
  SettingsRow,
  SettingsSection,
  Switch,
} from "@kit";
import {
  findNotesByQuery,
  listDecks,
  listModelFields,
  listModels,
} from "@texthooker/lib/ankiconnect";
import { detectAnkiSetup } from "@texthooker/lib/ankiDetect";
import { ankiMiningGap } from "@texthooker/lib/ankiConfig";
import { DEFAULT_ANKI_CONNECT_URL } from "@ui/anki-connect";
import { updateSettings } from "@texthooker/lib/settings";
import type { AnkiFieldMapping, Settings } from "@texthooker/lib/types";
import { YOMITAN_MARKERS } from "@texthooker/lib/types";
import {
  extractConfigFromCardFormat,
  findTermCardFormats,
  type CardFormatOption,
  type ImportedConfig,
} from "@texthooker/lib/yomitanImport";

interface Props {
  settings: Settings;
  /** Changes when AnkiConnect (re)connects, so the deck and note type lists are fetched again.
   *  The address, key and connection status are Settings → Anki's (AnkiTab). */
  connection?: unknown;
  title?: ReactNode;
  description?: ReactNode;
}

/** `options` with the saved value added when it is missing (AnkiConnect not answering, or a deck
    renamed in Anki), so the select shows what is saved instead of an empty placeholder. */
function withSaved(options: string[], saved: string | null): string[] {
  return saved && !options.includes(saved) ? [saved, ...options] : options;
}

/** The Yomitan API pop-up's Add to Anki: on/off, deck, note type, tags and field mapping. */
export function AnkiSetup({ settings, connection, title, description }: Props) {
  // Empty is AnkiConnect's default address, as Settings → Anki's Address field shows it.
  const ankiUrl = settings.ankiConnectUrl.trim() || DEFAULT_ANKI_CONNECT_URL;
  const [tagsDraft, setTagsDraft] = useState(settings.ankiTags.join(", "));
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
  /** Set when the preview is Detect's rather than an import's: how many notes it found. */
  const [detected, setDetected] = useState<{ modelNotes: number; deckNotes: number } | null>(null);
  const [detecting, setDetecting] = useState(false);
  /** Detect found nothing to suggest: said plainly, not as an error. */
  const [detectNote, setDetectNote] = useState<string | null>(null);

  const resetImport = () => {
    setImportOptions([]);
    setImportIndex(0);
    setImportPreview(null);
    setImportError(null);
    setDetected(null);
    setDetectNote(null);
  };

  const handleDetectClick = async () => {
    resetImport();
    setDetecting(true);
    const url = ankiUrl;
    try {
      const found = await detectAnkiSetup({
        models: () => listModels(url),
        fields: (model) => listModelFields(url, model),
        decks: () => listDecks(url),
        findNotes: (query) => findNotesByQuery(url, query),
      });
      if (!found.ok) {
        setDetectNote(found.reason);
        return;
      }
      setDetected({ modelNotes: found.modelNotes, deckNotes: found.deckNotes });
      setImportPreview({
        deckName: found.deckName,
        modelName: found.modelName,
        fieldMappings: found.fieldMappings,
        tags: [],
      });
    } catch (err) {
      setImportError(`Couldn't read your Anki setup: ${err}`);
    } finally {
      setDetecting(false);
    }
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
      // Detect is for turning mining on; an import only brings settings over.
      ...(detected ? { ankiEnabled: true } : {}),
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

  useEffect(() => {
    setTagsDraft(settings.ankiTags.join(", "));
  }, [settings.ankiTags]);

  // Load decks + models whenever the URL changes, AnkiConnect connects, or after an import.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [d, m] = await Promise.all([
          listDecks(ankiUrl),
          listModels(ankiUrl),
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
  }, [ankiUrl, connection, refreshTick]);

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
          ankiUrl,
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
  }, [ankiUrl, settings.ankiModelName, connection, refreshTick]);

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
      Sentinels: "" = unmapped, "(sentence)" = sentence-cloze-style,
      "(sentence audio)" = the line's recorded audio. Plain
      strings that match a known marker are markers; anything else is literal. */
  const mappingToValue = (m: AnkiFieldMapping | null): string => {
    if (!m) return "";
    switch (m.mappingType) {
      case "empty":
        return "";
      case "sentence":
        return "(sentence)";
      case "sentenceAudio":
        return "(sentence audio)";
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
    if (trimmed === "(sentence audio)") {
      return { ankiField, mappingType: "sentenceAudio" };
    }
    if ((YOMITAN_MARKERS as readonly string[]).includes(trimmed)) {
      return { ankiField, mappingType: "marker", marker: trimmed };
    }
    return { ankiField, mappingType: "literal", literal: value };
  };

  return (
    <>
      <SettingsSection title={title ?? "Cards from Kimochi's pop-up"} description={description}>
        <SettingsRow
          label="Enable Mining"
          controlId="anki-enabled"
          description='Shows the "+" button in the lookup pop-up.'
        >
          <Switch
            id="anki-enabled"
            checked={settings.ankiEnabled}
            onCheckedChange={(v) => void updateSettings({ ankiEnabled: v })}
          />
        </SettingsRow>
        {settings.ankiEnabled && ankiMiningGap(settings, modelFields.length > 0) ? (
          <div className="settings-note">
            <Callout tone="warn">{ankiMiningGap(settings, modelFields.length > 0)}</Callout>
          </div>
        ) : null}
        <SettingsRow label="Deck">
          <Select
            aria-label="Deck"
            value={settings.ankiDeckName ?? ""}
            onValueChange={(v) => void updateSettings({ ankiDeckName: v === "" ? null : v })}
            disabled={decks.length === 0 && !settings.ankiDeckName}
            placeholder="Select deck"
            options={withSaved(decks, settings.ankiDeckName).map((d) => ({ value: d, label: d }))}
          />
        </SettingsRow>
        <SettingsRow label="Note type">
          <Select
            aria-label="Note type"
            value={settings.ankiModelName ?? ""}
            onValueChange={(v) =>
              void updateSettings({
                ankiModelName: v === "" ? null : v,
                ankiFieldMappings: [],
                ankiModelFields: [],
              })
            }
            disabled={models.length === 0 && !settings.ankiModelName}
            placeholder="Select note type"
            options={withSaved(models, settings.ankiModelName).map((m) => ({ value: m, label: m }))}
          />
        </SettingsRow>
        <SettingsRow
          label="Tags"
          controlId="anki-tags"
          description="Comma-separated, added to every card."
        >
          <Input
            id="anki-tags"
            className="settings-field"
            value={tagsDraft}
            onChange={(e) => setTagsDraft(e.target.value)}
            onBlur={() => void handleTagsBlur()}
            placeholder="super-texthooker"
          />
        </SettingsRow>
        <SettingsRow
          label="Detect from Anki"
          description="Attempt to auto-detect your Anki mining setup and import it here."
        >
          <Button size="sm" onClick={() => void handleDetectClick()} disabled={detecting}>
            {detecting ? "Detecting…" : "Detect"}
          </Button>
        </SettingsRow>
        <SettingsRow
          label="Import from Yomitan"
          description="Deck, note type, tags and field mappings from a Yomitan settings export."
        >
          <Button size="sm" onClick={() => void handleImportClick()}>
            Import…
          </Button>
        </SettingsRow>
        {detectNote ? (
          <div className="settings-note">
            <Callout>
              <span>{detectNote}</span>
              <Button size="sm" onClick={() => setDetectNote(null)}>
                Dismiss
              </Button>
            </Callout>
          </div>
        ) : null}
        {importError ? (
          <div className="settings-note">
            <Callout tone="danger">
              <span>{importError}</span>
              <Button size="sm" onClick={() => setImportError(null)}>
                Dismiss
              </Button>
            </Callout>
          </div>
        ) : null}
        {importPreview ? (
          <SettingsRow stacked label={detected ? "Found in Anki" : "Preview import"}>
            <div className="anki-preview">
              {importOptions.length > 1 ? (
                <>
                  <p className="k-description">Multiple Yomitan profiles found:</p>
                  <ChoiceGroup
                    aria-label="Yomitan profile"
                    value={String(importIndex)}
                    onValueChange={(v) => handleImportSelectIndex(Number(v))}
                    options={importOptions.map((o, i) => ({
                      value: String(i),
                      label: o.profileName,
                      detail: o.cardFormat.model,
                    }))}
                  />
                </>
              ) : null}
              <dl className="anki-preview-meta">
                <dt>Deck</dt>
                <dd>
                  {importPreview.deckName}
                  {detected ? (
                    <span className="k-description">
                      {" "}(<span className="k-num">{detected.deckNotes.toLocaleString()}</span> notes)
                    </span>
                  ) : null}
                </dd>
                <dt>Note type</dt>
                <dd>
                  {importPreview.modelName}
                  {detected ? (
                    <span className="k-description">
                      {" "}(<span className="k-num">{detected.modelNotes.toLocaleString()}</span> notes)
                    </span>
                  ) : null}
                </dd>
                {importPreview.tags.length > 0 ? (
                  <>
                    <dt>Tags</dt>
                    <dd>{importPreview.tags.join(", ")}</dd>
                  </>
                ) : null}
              </dl>
              <p className="k-description">
                Field mappings (<span className="k-num">{importPreview.fieldMappings.length}</span>)
              </p>
              <dl className="anki-preview-map">
                {importPreview.fieldMappings.length === 0 ? (
                  <div>
                    <dd>No mappings detected.</dd>
                  </div>
                ) : (
                  importPreview.fieldMappings.map((m) => (
                    <div key={m.ankiField}>
                      <dt>{m.ankiField}</dt>
                      <dd className="k-mono">
                        {m.mappingType === "sentence"
                          ? "(sentence)"
                          : m.mappingType === "sentenceAudio"
                            ? "(sentence audio)"
                            : m.mappingType === "marker"
                            ? m.marker
                            : m.mappingType === "literal"
                              ? `"${m.literal ?? ""}"`
                              : "—"}
                      </dd>
                    </div>
                  ))
                )}
              </dl>
              <div className="anki-preview-actions">
                <Button variant="ghost" size="sm" onClick={resetImport}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" onClick={() => void handleImportConfirm()}>
                  Apply
                </Button>
              </div>
            </div>
          </SettingsRow>
        ) : null}
      </SettingsSection>

      {modelFields.length > 0 ? (
        <SettingsSection
          title="Field mapping"
          description={
            <>
              Type a Yomitan marker, <span className="k-mono">(sentence)</span>,{" "}
              <span className="k-mono">(sentence audio)</span> (with Sentence Audio on, below), or
              literal text.
            </>
          }
        >
          <datalist id="anki-mapping-options">
            <option value="(sentence)" />
            <option value="(sentence audio)" />
            {YOMITAN_MARKERS.map((mk) => (
              <option key={mk} value={mk} />
            ))}
          </datalist>
          {modelFields.map((f) => {
            const m = getMapping(f);
            const display = mappingToValue(m);
            return (
              <SettingsRow key={f} label={f} controlId={`anki-map-${f}`}>
                <Input
                  // Uncontrolled while typing; keyed by the saved mapping so one that Detect or
                  // an import (or another window) changed replaces what the field shows.
                  key={display}
                  id={`anki-map-${f}`}
                  size="sm"
                  mono
                  className="anki-mapping-field"
                  list="anki-mapping-options"
                  defaultValue={display}
                  placeholder="(unmapped)"
                  onBlur={(e) => {
                    const next = valueToMapping(f, e.target.value);
                    const before = mappingToValue(m);
                    if (e.target.value === before) return;
                    setMapping(f, next);
                  }}
                />
              </SettingsRow>
            );
          })}
        </SettingsSection>
      ) : null}
    </>
  );
}
