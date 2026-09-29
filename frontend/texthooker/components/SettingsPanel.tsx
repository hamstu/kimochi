/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState, type ReactNode } from "react";
import { Camera, Check, Clipboard, Radio } from "lucide-react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import {
  Button,
  Callout,
  Input,
  Select,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSubgroup,
  Slider,
  Switch,
} from "@kit";
import { AnkiSetup } from "@texthooker/components/AnkiSetup";
import { ExplainSettingsModal } from "@texthooker/components/ExplainSettingsModal";
import { ReplacementsEditor } from "@texthooker/components/ReplacementsEditor";
import { resetSettings, updateSettings } from "@texthooker/lib/settings";
import { clearAudioCache } from "@texthooker/lib/audio";
import { clearLines, lineCount } from "@texthooker/lib/store";
import { resetStats } from "@texthooker/lib/stats";
import { type Settings } from "@texthooker/lib/types";
import OutputSettings from "../OutputSettings";
import { useSetting } from "../../bridge/useSetting";

interface Props {
  open: boolean;
  settings: Settings;
  /** An unhandled error from the texthooker client, shown above the page. */
  error?: string;
}

type InputSource = Settings["inputSource"];

const INPUT_SOURCES = [
  {
    value: "ocr",
    label: "OCR",
    icon: <Camera />,
    detail: "Screen captures and manual scans appear automatically.",
  },
  {
    value: "clipboard",
    label: "Clipboard",
    icon: <Clipboard />,
    detail: "Picks up text copied to the clipboard.",
  },
  {
    value: "websocket",
    label: "WebSocket",
    icon: <Radio />,
    detail: "Receives plain-text messages from a text source.",
  },
] as const satisfies readonly { value: InputSource; label: string; icon: ReactNode; detail: string }[];

const CLIPBOARD_POLL = [
  { value: "100", label: "100 ms" },
  { value: "200", label: "200 ms" },
  { value: "500", label: "500 ms" },
  { value: "1000", label: "1 s" },
];

/** A clamped integer field on the right of a settings row. */
function NumberField({
  id,
  value,
  min,
  max,
  step,
  fallback,
  disabled,
  onCommit,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fallback: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
  "aria-label"?: string;
}) {
  return (
    <Input
      id={id}
      type="number"
      className="settings-field-num k-num"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={value}
      onChange={(e) =>
        onCommit(Math.max(min, Math.min(max, parseInt(e.target.value, 10) || fallback)))
      }
    />
  );
}

/** A destructive action that needs a second click to confirm. */
function ArmedButton({
  armed,
  onArm,
  onCancel,
  onConfirm,
  label,
  confirmLabel,
}: {
  armed: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  label: string;
  confirmLabel: string;
}) {
  return (
    <>
      {armed ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      <Button variant="danger" size="sm" onClick={armed ? onConfirm : onArm}>
        {armed ? confirmLabel : label}
      </Button>
    </>
  );
}

export function SettingsPanel({ open, settings, error }: Props) {
  const [, setActiveSettingsTab] = useSetting("settingsActiveTab", "mode");
  const [linesCount, setLinesCount] = useState(lineCount());
  const [deeplDraft, setDeeplDraft] = useState(settings.deeplApiKey);
  const [clearArmed, setClearArmed] = useState(false);
  const [explainSettingsOpen, setExplainSettingsOpen] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [statsResetArmed, setStatsResetArmed] = useState(false);

  // Keep drafts in sync with settings.
  useEffect(() => {
    setDeeplDraft(settings.deeplApiKey);
  }, [settings.deeplApiKey]);

  // Refresh lines count when panel opens. Also re-arm destructive buttons.
  useEffect(() => {
    if (open) {
      setLinesCount(lineCount());
      setClearArmed(false);
      setResetArmed(false);
      setStatsResetArmed(false);
    }
  }, [open]);

  const handleAlwaysOnTop = async (next: boolean) => {
    await updateSettings({ alwaysOnTop: next });
  };

  const handleClearLines = () => {
    console.log("[settings] CONFIRMING clear, calling clearLines()");
    clearLines();
    console.log("[settings] clearLines() returned, lineCount =", lineCount());
    setLinesCount(0);
    setClearArmed(false);
  };

  const handleResetSettings = async () => {
    await resetSettings();
    setResetArmed(false);
  };

  const volume = Math.round(settings.audioVolume * 100);
  const explainSummary =
    settings.explainProvider === "claude"
      ? `Claude CLI · ${settings.explainClaudeModel}`
      : `Codex CLI${settings.explainCodexModel ? ` · ${settings.explainCodexModel}` : ""}`;

  return (
    <SettingsPage
      title="Texthooker"
      description="Where lines come from, how the Log shows them, and what you can do with them."
    >
      {error ? (
        <Callout tone="danger" className="settings-page-callout">
          {error}
        </Callout>
      ) : null}

      <SettingsSection title="Input source">
        <ToggleGroup.Root
          type="single"
          value={settings.inputSource}
          onValueChange={(value) => value && void updateSettings({ inputSource: value as InputSource })}
          className="input-source-list"
          aria-label="Input source"
        >
          {INPUT_SOURCES.map((option) => (
            <ToggleGroup.Item key={option.value} value={option.value} className="input-source-row">
              <span className="input-source-icon" aria-hidden>
                {option.icon}
              </span>
              <span className="input-source-text">
                <span className="input-source-label">{option.label}</span>
                <span className="input-source-detail">{option.detail}</span>
              </span>
              {settings.inputSource === option.value ? (
                <Check className="input-source-check" aria-hidden />
              ) : null}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        {settings.inputSource === "clipboard" ? (
          <SettingsRow label="Poll interval" description="How often the clipboard is checked.">
            <Select
              aria-label="Poll interval"
              value={String(settings.clipboardPollMs)}
              onValueChange={(v) => void updateSettings({ clipboardPollMs: Number(v) })}
              options={CLIPBOARD_POLL}
            />
          </SettingsRow>
        ) : null}
        {settings.inputSource === "websocket" ? (
          <SettingsRow
            label="WebSocket URL"
            controlId="texthooker-ws-url"
            description="A text source that sends plain-text messages."
          >
            <Input
              id="texthooker-ws-url"
              type="url"
              mono
              className="settings-field"
              value={settings.websocketUrl}
              onChange={(event) => void updateSettings({ websocketUrl: event.target.value })}
              placeholder="ws://localhost:6677"
            />
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Kimochi integration" footnote="Window pinning uses the Log title bar.">
        <SettingsRow label="Match sessions to window names" controlId="texthooker-auto-match">
          <Switch
            id="texthooker-auto-match"
            checked={settings.autoMatchSource}
            onCheckedChange={(value) => void updateSettings({ autoMatchSource: value })}
          />
        </SettingsRow>
        <SettingsRow label="Dictionary" description="Dictionary mode and API address are set in Dictionary.">
          <Button size="sm" onClick={() => void setActiveSettingsTab("yomitan")}>
            Open Dictionary
          </Button>
        </SettingsRow>
      </SettingsSection>

      <OutputSettings />

      <SettingsSection title="Reading">
        <SettingsRow label="Font size" controlId="texthooker-font-size" description="Log text size in pixels, 12 to 48.">
          <NumberField
            id="texthooker-font-size"
            value={settings.fontSizePx}
            min={12}
            max={48}
            step={1}
            fallback={22}
            onCommit={(v) => void updateSettings({ fontSizePx: v })}
          />
        </SettingsRow>
        <SettingsRow label="Show furigana" controlId="texthooker-furigana">
          <Switch
            id="texthooker-furigana"
            checked={settings.showFurigana}
            onCheckedChange={(v) => void updateSettings({ showFurigana: v })}
          />
        </SettingsRow>
        <SettingsRow label="Always on top" controlId="texthooker-on-top">
          <Switch
            id="texthooker-on-top"
            checked={settings.alwaysOnTop}
            onCheckedChange={(v) => void handleAlwaysOnTop(v)}
          />
        </SettingsRow>
        <SettingsRow label="Tokenize on arrival" controlId="texthooker-tokenize">
          <Switch
            id="texthooker-tokenize"
            checked={settings.tokenizeOnArrival}
            onCheckedChange={(v) => void updateSettings({ tokenizeOnArrival: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Disable click-to-define"
          controlId="texthooker-no-click"
          description="Tokens become selectable text. Shift-hover still shows definitions."
        >
          <Switch
            id="texthooker-no-click"
            checked={settings.disableClickToDefine}
            onCheckedChange={(v) => void updateSettings({ disableClickToDefine: v })}
          />
        </SettingsRow>
      </SettingsSection>

      <AnkiSetup settings={settings} />

      <SettingsSection title="Audio">
        <SettingsRow
          label="Fetch audio"
          controlId="texthooker-audio"
          description="Pulls audio from Yomitan with each lookup."
        >
          <Switch
            id="texthooker-audio"
            checked={settings.audioEnabled}
            onCheckedChange={(v) => {
              if (!v) clearAudioCache();
              void updateSettings({ audioEnabled: v });
            }}
          />
        </SettingsRow>
        {settings.audioEnabled ? (
          <SettingsSubgroup>
            <SettingsRow label="Autoplay on lookup" controlId="texthooker-autoplay">
              <Switch
                id="texthooker-autoplay"
                checked={settings.audioAutoplay}
                onCheckedChange={(v) => void updateSettings({ audioAutoplay: v })}
              />
            </SettingsRow>
            <SettingsRow label="Volume">
              <div className="settings-slider">
                <Slider
                  aria-label="Volume"
                  value={[volume]}
                  min={0}
                  max={100}
                  step={5}
                  onValueChange={(values) => void updateSettings({ audioVolume: values[0] / 100 })}
                />
                <span className="settings-slider-value k-num">{volume}%</span>
              </div>
            </SettingsRow>
          </SettingsSubgroup>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Translation">
        <SettingsRow
          label="DeepL API key"
          controlId="texthooker-deepl"
          description={
            settings.deeplApiKey.trim()
              ? "Key set. Translate is available in each line's menu."
              : "Required for Translate. Stored locally in settings.json, never bundled."
          }
        >
          <Input
            id="texthooker-deepl"
            type="password"
            mono
            autoComplete="off"
            className="settings-field"
            value={deeplDraft}
            onChange={(e) => setDeeplDraft(e.target.value)}
            onBlur={() => {
              const next = deeplDraft.trim();
              if (next !== settings.deeplApiKey) {
                void updateSettings({ deeplApiKey: next });
              }
            }}
            placeholder="xxxxxxxx-…-xxxxxxxx:fx"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Explain (LLM)">
        <SettingsRow
          label="Provider, model and prompt"
          description={`${explainSummary}. Explain is in each line's menu and on the E key.`}
        >
          <Button size="sm" onClick={() => setExplainSettingsOpen(true)}>
            Configure…
          </Button>
        </SettingsRow>
      </SettingsSection>

      <ReplacementsEditor />

      <SettingsSection title="Lookup popover">
        <SettingsRow label="Width" controlId="texthooker-pop-w" description="In pixels, 280 to 900.">
          <NumberField
            id="texthooker-pop-w"
            value={settings.popoverWidth}
            min={280}
            max={900}
            step={10}
            fallback={480}
            onCommit={(v) => void updateSettings({ popoverWidth: v })}
          />
        </SettingsRow>
        <SettingsRow label="Height" controlId="texthooker-pop-h" description="In pixels, 200 to 800.">
          <NumberField
            id="texthooker-pop-h"
            value={settings.popoverHeight}
            min={200}
            max={800}
            step={10}
            fallback={360}
            onCommit={(v) => void updateSettings({ popoverHeight: v })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Lines">
        <SettingsRow
          label="Dedupe depth"
          controlId="texthooker-dedupe"
          description="Drop incoming lines that match any of the last N lines."
        >
          <NumberField
            id="texthooker-dedupe"
            value={settings.dedupeDepth}
            min={1}
            max={20}
            step={1}
            fallback={1}
            onCommit={(v) => void updateSettings({ dedupeDepth: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Japanese only"
          controlId="texthooker-cjk"
          description="Silently drop lines with no Japanese characters."
        >
          <Switch
            id="texthooker-cjk"
            checked={settings.cjkOnly}
            onCheckedChange={(v) => void updateSettings({ cjkOnly: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="Merge streamed lines"
          controlId="texthooker-merge"
          description="Replace the previous line when its first N characters match."
        >
          <Switch
            id="texthooker-merge"
            checked={settings.startMergeEnabled}
            onCheckedChange={(v) => void updateSettings({ startMergeEnabled: v })}
          />
        </SettingsRow>
        {settings.startMergeEnabled ? (
          <SettingsSubgroup>
            <SettingsRow label="Merge prefix length" controlId="texthooker-merge-len" description="N, in characters.">
              <NumberField
                id="texthooker-merge-len"
                value={settings.startMergePrefixLen}
                min={1}
                max={20}
                step={1}
                fallback={4}
                onCommit={(v) => void updateSettings({ startMergePrefixLen: v })}
              />
            </SettingsRow>
          </SettingsSubgroup>
        ) : null}
        <SettingsRow
          label="Max lines"
          controlId="texthooker-max-lines"
          description="Oldest lines are dropped past this cap."
        >
          <NumberField
            id="texthooker-max-lines"
            value={settings.maxLines}
            min={100}
            max={50000}
            step={100}
            fallback={5000}
            onCommit={(v) => void updateSettings({ maxLines: v })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Stats">
        <SettingsRow
          label="AFK pause after"
          controlId="texthooker-afk"
          description="Seconds idle before the reading timer pauses."
        >
          <NumberField
            id="texthooker-afk"
            value={settings.afkThresholdSec}
            min={10}
            max={600}
            step={5}
            fallback={60}
            onCommit={(v) => void updateSettings({ afkThresholdSec: v })}
          />
        </SettingsRow>
        <SettingsRow label="Show timer" controlId="texthooker-stat-time">
          <Switch
            id="texthooker-stat-time"
            checked={settings.statsShowTime}
            onCheckedChange={(v) => void updateSettings({ statsShowTime: v })}
          />
        </SettingsRow>
        <SettingsRow label="Show line count" controlId="texthooker-stat-lines">
          <Switch
            id="texthooker-stat-lines"
            checked={settings.statsShowLines}
            onCheckedChange={(v) => void updateSettings({ statsShowLines: v })}
          />
        </SettingsRow>
        <SettingsRow label="Show character count" controlId="texthooker-stat-chars">
          <Switch
            id="texthooker-stat-chars"
            checked={settings.statsShowChars}
            onCheckedChange={(v) => void updateSettings({ statsShowChars: v })}
          />
        </SettingsRow>
        <SettingsRow label="Show speed" controlId="texthooker-stat-speed" description="Characters per hour.">
          <Switch
            id="texthooker-stat-speed"
            checked={settings.statsShowSpeed}
            onCheckedChange={(v) => void updateSettings({ statsShowSpeed: v })}
          />
        </SettingsRow>
        <SettingsRow label="Reset stats">
          <ArmedButton
            armed={statsResetArmed}
            onArm={() => setStatsResetArmed(true)}
            onCancel={() => setStatsResetArmed(false)}
            onConfirm={() => {
              resetStats();
              setStatsResetArmed(false);
            }}
            label="Reset stats"
            confirmLabel="Confirm reset"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Data">
        <SettingsRow
          label="Clear all lines"
          description={
            <>
              <span className="k-num">{linesCount}</span> {linesCount === 1 ? "line" : "lines"} stored.
            </>
          }
        >
          <ArmedButton
            armed={clearArmed}
            onArm={() => {
              console.log("[settings] arming clear");
              setClearArmed(true);
            }}
            onCancel={() => setClearArmed(false)}
            onConfirm={handleClearLines}
            label="Clear all lines"
            confirmLabel="Confirm clear"
          />
        </SettingsRow>
        <SettingsRow label="Reset settings" description="Restores the Texthooker defaults.">
          <ArmedButton
            armed={resetArmed}
            onArm={() => setResetArmed(true)}
            onCancel={() => setResetArmed(false)}
            onConfirm={() => void handleResetSettings()}
            label="Reset settings"
            confirmLabel="Confirm reset"
          />
        </SettingsRow>
      </SettingsSection>

      <ExplainSettingsModal
        open={explainSettingsOpen}
        onOpenChange={setExplainSettingsOpen}
        settings={settings}
      />
    </SettingsPage>
  );
}
