/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
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
    <>
      <SettingsSection title="Anki">
        <SettingsRow
          label="Enable mining"
          controlId="anki-enabled"
          description="Shows Add to Anki in the lookup popover."
        >
          <Switch
            id="anki-enabled"
            checked={settings.ankiEnabled}
            onCheckedChange={(v) => void updateSettings({ ankiEnabled: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="AnkiConnect URL"
          controlId="anki-url"
          description={
            probeMsg ? (
              <span
                className="anki-probe"
                data-ok={probeMsg.ok ? "" : undefined}
                data-failed={probeMsg.ok ? undefined : ""}
              >
                {probeMsg.text}
              </span>
            ) : undefined
          }
        >
          <Input
            id="anki-url"
            mono
            className="settings-field"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => void handleUrlBlur()}
            placeholder="http://127.0.0.1:8765"
          />
          <Button size="sm" onClick={() => void handleTest()} disabled={probeBusy}>
            {probeBusy ? "Testing…" : "Test"}
          </Button>
        </SettingsRow>
        {disconnected ? (
          <div className="settings-note">
            <Callout tone="warn">
              <span>
                Could not reach AnkiConnect. Make sure Anki is running with the AnkiConnect
                add-on installed.
              </span>
              <Button size="sm" onClick={() => setRefreshTick((n) => n + 1)}>
                Retry
              </Button>
            </Callout>
          </div>
        ) : null}
        <SettingsRow label="Deck">
          <Select
            aria-label="Deck"
            value={settings.ankiDeckName ?? ""}
            onValueChange={(v) => void updateSettings({ ankiDeckName: v === "" ? null : v })}
            disabled={decks.length === 0}
            placeholder="Select deck"
            options={decks.map((d) => ({ value: d, label: d }))}
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
            disabled={models.length === 0}
            placeholder="Select note type"
            options={models.map((m) => ({ value: m, label: m }))}
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
          label="Import from Yomitan"
          description="Deck, note type, tags and field mappings from a Yomitan settings export."
        >
          <Button size="sm" onClick={() => void handleImportClick()}>
            Import…
          </Button>
        </SettingsRow>
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
          <SettingsRow stacked label="Preview import">
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
                <dd>{importPreview.deckName}</dd>
                <dt>Note type</dt>
                <dd>{importPreview.modelName}</dd>
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
              Type a Yomitan marker, <span className="k-mono">(sentence)</span>, or literal text.
            </>
          }
        >
          <datalist id="anki-mapping-options">
            <option value="(sentence)" />
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
