/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { Button } from "@texthooker/components/ui/button";
import { Switch } from "@texthooker/components/ui/switch";
import { Input } from "@texthooker/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@texthooker/components/ui/select";
import { Badge } from "@texthooker/components/ui/badge";
import { Camera, Clipboard, Radio } from "lucide-react";
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
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-(--color-border) pt-3 mb-4 first:border-t-0 first:pt-0">
      <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-(--color-text-dim) mb-2">
        {title}
      </h2>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
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

export function SettingsPanel({ open, settings }: Props) {
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
    if (!clearArmed) {
      console.log("[settings] arming clear");
      setClearArmed(true);
      return;
    }
    console.log("[settings] CONFIRMING clear, calling clearLines()");
    clearLines();
    console.log("[settings] clearLines() returned, lineCount =", lineCount());
    setLinesCount(0);
    setClearArmed(false);
  };

  const handleResetSettings = async () => {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    await resetSettings();
    setResetArmed(false);
  };

  return (
    <>
      <div className="texthooker-settings">
        <Group title="Kimochi integration">
          <Field label="Match sessions to window names">
            <Switch
              checked={settings.autoMatchSource}
              onCheckedChange={(value) =>
                void updateSettings({ autoMatchSource: value })
              }
            />
          </Field>
          <p className="text-xs text-(--color-text-muted)">
            Window pinning uses the Log title bar.
          </p>
          <Button variant="default" size="sm" onClick={() => void setActiveSettingsTab("yomitan")}>
            Configure dictionary mode and API address in Dictionary
          </Button>
        </Group>

        <Group title="Input source">
          <fieldset className="grid grid-cols-3 gap-2 reader-source-choices" aria-label="Input source">
            {([
              ["ocr", "OCR", Camera],
              ["clipboard", "Clipboard", Clipboard],
              ["websocket", "WebSocket", Radio],
            ] as const).map(([value, label, Icon]) => (
              <label
                key={value}
                className={`source-card ${settings.inputSource === value ? "source-card-selected" : ""}`}
              >
                <input
                  type="radio"
                  name="input-source"
                  value={value}
                  checked={settings.inputSource === value}
                  onChange={() => void updateSettings({ inputSource: value })}
                />
                <Icon size={18} strokeWidth={1.8} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          {settings.inputSource === "ocr" ? (
            <p className="source-detail">Screen captures and manual scans appear here automatically.</p>
          ) : null}
          {settings.inputSource === "clipboard" ? <Field label="Poll interval">
            <Select
              value={String(settings.clipboardPollMs)}
              onValueChange={(v) =>
                updateSettings({ clipboardPollMs: Number(v) })
              }
            >
              <SelectTrigger className="w-[6.875rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="100">100 ms</SelectItem>
                <SelectItem value="200">200 ms</SelectItem>
                <SelectItem value="500">500 ms</SelectItem>
                <SelectItem value="1000">1 s</SelectItem>
              </SelectContent>
            </Select>
          </Field> : null}
          {settings.inputSource === "websocket" ? (
            <Field label="WebSocket URL" hint="Connect to a text source that sends plain-text messages">
              <Input
                type="url"
                value={settings.websocketUrl}
                onChange={(event) => void updateSettings({ websocketUrl: event.target.value })}
                placeholder="ws://localhost:6677"
                className="w-full max-w-[13rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs"
              />
            </Field>
          ) : null}
        </Group>

        <OutputSettings />

        <Group title="Reading">
          <Field label="Font size">
            <Input
              type="number"
              min={12}
              max={48}
              step={1}
              value={settings.fontSizePx}
              onChange={(e) => {
                const v = Math.max(
                  12,
                  Math.min(48, parseInt(e.target.value, 10) || 22),
                );
                updateSettings({ fontSizePx: v });
              }}
              className="w-[5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-right"
            />
          </Field>

          <Field label="Show furigana">
            <Switch
              checked={settings.showFurigana}
              onCheckedChange={(v) => updateSettings({ showFurigana: v })}
            />
          </Field>

          <Field label="Always on top">
            <Switch
              checked={settings.alwaysOnTop}
              onCheckedChange={handleAlwaysOnTop}
            />
          </Field>

          <Field label="Tokenize on arrival">
            <Switch
              checked={settings.tokenizeOnArrival}
              onCheckedChange={(v) => updateSettings({ tokenizeOnArrival: v })}
            />
          </Field>

          <Field
            label="Disable click-to-define"
            hint="Tokens become selectable text. Shift-hover still shows definitions."
          >
            <Switch
              checked={settings.disableClickToDefine}
              onCheckedChange={(v) =>
                updateSettings({ disableClickToDefine: v })
              }
            />
          </Field>
        </Group>

        <Group title="Anki">
          <AnkiSetup settings={settings} />
        </Group>

        <Group title="Audio">
          <Field
            label="Fetch audio"
            hint="Pulls audio bytes from Yomitan with each lookup"
          >
            <Switch
              checked={settings.audioEnabled}
              onCheckedChange={(v) => {
                if (!v) clearAudioCache();
                void updateSettings({ audioEnabled: v });
              }}
            />
          </Field>

          <Field label="Autoplay on lookup">
            <Switch
              checked={settings.audioAutoplay}
              disabled={!settings.audioEnabled}
              onCheckedChange={(v) => updateSettings({ audioAutoplay: v })}
            />
          </Field>

          <Field label="Volume">
            <Input
              type="number"
              min={0}
              max={100}
              step={5}
              value={Math.round(settings.audioVolume * 100)}
              onChange={(e) => {
                const pct = Math.max(
                  0,
                  Math.min(100, parseInt(e.target.value, 10) || 0),
                );
                updateSettings({ audioVolume: pct / 100 });
              }}
              className="w-[5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-right"
            />
          </Field>
        </Group>

        <Group title="Translation">
          <Field
            label="DeepL API key"
            hint={
              settings.deeplApiKey.trim()
                ? "Key set — Translate is available in each line's menu"
                : "Stored locally in settings.json, never bundled. Required to enable Translate."
            }
          >
            <Input
              type="password"
              autoComplete="off"
              value={deeplDraft}
              onChange={(e) => setDeeplDraft(e.target.value)}
              onBlur={() => {
                const next = deeplDraft.trim();
                if (next !== settings.deeplApiKey) {
                  void updateSettings({ deeplApiKey: next });
                }
              }}
              placeholder="xxxxxxxx-…-xxxxxxxx:fx"
              className="w-full max-w-[12.5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs"
            />
          </Field>
        </Group>

        <Group title="Explain (LLM)">
          <Field
            label="Provider, model & prompt"
            hint={`Currently: ${
              settings.explainProvider === "claude"
                ? `Claude CLI · ${settings.explainClaudeModel}`
                : `Codex CLI${settings.explainCodexModel ? ` · ${settings.explainCodexModel}` : ""}`
            }. Explain is in each line's menu and on the E key.`}
          >
            <Button
              variant="default"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setExplainSettingsOpen(true)}
            >
              Configure…
            </Button>
          </Field>
        </Group>

        <Group title="Text processing">
          <ReplacementsEditor />
        </Group>

        <Group title="Popover">
          <Field label="Width">
            <Input
              type="number"
              min={280}
              max={900}
              step={10}
              value={settings.popoverWidth}
              onChange={(e) => {
                const v = Math.max(
                  280,
                  Math.min(900, parseInt(e.target.value, 10) || 480),
                );
                updateSettings({ popoverWidth: v });
              }}
              className="w-[5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-right"
            />
          </Field>
          <Field label="Height">
            <Input
              type="number"
              min={200}
              max={800}
              step={10}
              value={settings.popoverHeight}
              onChange={(e) => {
                const v = Math.max(
                  200,
                  Math.min(800, parseInt(e.target.value, 10) || 360),
                );
                updateSettings({ popoverHeight: v });
              }}
              className="w-[5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-right"
            />
          </Field>
        </Group>

        <Group title="Lines">
          <Field
            label="Dedupe depth"
            hint="Drop incoming lines matching any of the last N lines"
          >
            <Input
              type="number"
              min={1}
              max={20}
              step={1}
              value={settings.dedupeDepth}
              onChange={(e) => {
                const v = Math.max(
                  1,
                  Math.min(20, parseInt(e.target.value, 10) || 1),
                );
                updateSettings({ dedupeDepth: v });
              }}
              className="w-[5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-right"
            />
          </Field>

          <Field
            label="CJK-only filter"
            hint="Silently drop lines with no Japanese characters"
          >
            <Switch
              checked={settings.cjkOnly}
              onCheckedChange={(v) => updateSettings({ cjkOnly: v })}
            />
          </Field>

          <Field
            label="Merge streamed lines"
            hint="Replace previous line when first N chars match"
          >
            <Switch
              checked={settings.startMergeEnabled}
              onCheckedChange={(v) => updateSettings({ startMergeEnabled: v })}
            />
          </Field>

          <Field label="Merge prefix length">
            <Input
              type="number"
              min={1}
              max={20}
              step={1}
              disabled={!settings.startMergeEnabled}
              value={settings.startMergePrefixLen}
              onChange={(e) => {
                const v = Math.max(
                  1,
                  Math.min(20, parseInt(e.target.value, 10) || 4),
                );
                updateSettings({ startMergePrefixLen: v });
              }}
              className="w-[5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-right disabled:opacity-50"
            />
          </Field>

          <Field label="Max lines" hint="FIFO cap on the line buffer">
            <Input
              type="number"
              min={100}
              max={50000}
              step={100}
              value={settings.maxLines}
              onChange={(e) => {
                const v = Math.max(
                  100,
                  Math.min(50000, parseInt(e.target.value, 10) || 5000),
                );
                updateSettings({ maxLines: v });
              }}
              className="w-[5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-right"
            />
          </Field>
        </Group>

        <Group title="Stats">
          <Field
            label="AFK pause after"
            hint="Pause the reading timer after this many idle seconds"
          >
            <Input
              type="number"
              min={10}
              max={600}
              step={5}
              value={settings.afkThresholdSec}
              onChange={(e) => {
                const v = Math.max(
                  10,
                  Math.min(600, parseInt(e.target.value, 10) || 60),
                );
                updateSettings({ afkThresholdSec: v });
              }}
              className="w-[5rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-right"
            />
          </Field>

          <Field label="Show timer">
            <Switch
              checked={settings.statsShowTime}
              onCheckedChange={(v) => updateSettings({ statsShowTime: v })}
            />
          </Field>

          <Field label="Show line count">
            <Switch
              checked={settings.statsShowLines}
              onCheckedChange={(v) => updateSettings({ statsShowLines: v })}
            />
          </Field>

          <Field label="Show char count">
            <Switch
              checked={settings.statsShowChars}
              onCheckedChange={(v) => updateSettings({ statsShowChars: v })}
            />
          </Field>

          <Field label="Show speed (c/h)">
            <Switch
              checked={settings.statsShowSpeed}
              onCheckedChange={(v) => updateSettings({ statsShowSpeed: v })}
            />
          </Field>

          <div className="flex justify-end gap-2">
            {statsResetArmed ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStatsResetArmed(false)}
              >
                Cancel
              </Button>
            ) : null}
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (!statsResetArmed) {
                  setStatsResetArmed(true);
                  return;
                }
                resetStats();
                setStatsResetArmed(false);
              }}
            >
              {statsResetArmed ? "Confirm reset" : "Reset stats"}
            </Button>
          </div>
        </Group>

        <Group title="Data">
          <Field label="Lines stored">
            <Badge>{linesCount}</Badge>
          </Field>

          <div className="flex justify-end gap-2">
            {clearArmed ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setClearArmed(false)}
              >
                Cancel
              </Button>
            ) : null}
            <Button variant="danger" size="sm" onClick={handleClearLines}>
              {clearArmed ? "Confirm clear" : "Clear all lines"}
            </Button>
          </div>

          <div className="flex justify-end gap-2">
            {resetArmed ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setResetArmed(false)}
              >
                Cancel
              </Button>
            ) : null}
            <Button variant="danger" size="sm" onClick={handleResetSettings}>
              {resetArmed ? "Confirm reset" : "Reset settings"}
            </Button>
          </div>
        </Group>

        <div className="mt-auto pt-3 border-t border-(--color-border) text-[0.625rem] text-(--color-text-muted)">
          Kimochi Texthooker
        </div>
      </div>

      <ExplainSettingsModal
        open={explainSettingsOpen}
        onOpenChange={setExplainSettingsOpen}
        settings={settings}
      />
    </>
  );
}
