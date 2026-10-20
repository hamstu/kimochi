/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  Input,
  Select,
  SettingsRow,
  Textarea,
} from "@kit";
import { updateSettings } from "@texthooker/lib/settings";
import { DEFAULT_EXPLAIN_PROMPT } from "@texthooker/lib/types";
import type { ExplainProvider, Settings } from "@texthooker/lib/types";
import { useAccount } from "../../bridge/account";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
}

/** Claude CLI model aliases. Opus is the default per project preference —
    deliberately not the newer Fable tier, though it stays selectable. */
const CLAUDE_MODELS = [
  { value: "opus", label: "Opus (default)" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];

export function ExplainSettingsModal({ open, onOpenChange, settings }: Props) {
  const { cloud } = useAccount();
  const [promptDraft, setPromptDraft] = useState(settings.explainPrompt);
  const [codexModelDraft, setCodexModelDraft] = useState(
    settings.explainCodexModel,
  );

  useEffect(() => {
    if (open) {
      setPromptDraft(settings.explainPrompt);
      setCodexModelDraft(settings.explainCodexModel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const savePrompt = () => {
    const next = promptDraft.trim() ? promptDraft : DEFAULT_EXPLAIN_PROMPT;
    if (next !== settings.explainPrompt) {
      void updateSettings({ explainPrompt: next });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="Explain settings"
        description="The model that explains a line, and the prompt it gets."
      >
        <div className="explain-settings">
          <div className="k-settings-group">
            <SettingsRow label="Provider">
              <Select
                aria-label="Provider"
                value={settings.explainProvider}
                onValueChange={(v) =>
                  void updateSettings({ explainProvider: v as ExplainProvider })
                }
                // Kimochi cloud needs Kimochi Cloud; still listed while it is the choice.
                options={[
                  { value: "kimochi", label: "Kimochi cloud" },
                  { value: "codex", label: "Codex CLI" },
                  { value: "claude", label: "Claude CLI" },
                ].filter((o) => o.value !== "kimochi" || cloud || settings.explainProvider === "kimochi")}
              />
            </SettingsRow>
            {settings.explainProvider === "kimochi" ? (
              <SettingsRow
                label="Kimochi cloud"
                description={
                  cloud
                    ? "Runs on Kimochi's server within your Kimochi Cloud monthly explanations."
                    : "Needs Kimochi Cloud: see Settings → Account."
                }
              />
            ) : settings.explainProvider === "claude" ? (
              <SettingsRow label="Claude model">
                <Select
                  aria-label="Claude model"
                  value={settings.explainClaudeModel}
                  onValueChange={(v) => void updateSettings({ explainClaudeModel: v })}
                  options={CLAUDE_MODELS}
                />
              </SettingsRow>
            ) : (
              <SettingsRow label="Codex model" controlId="explain-codex-model">
                <Input
                  id="explain-codex-model"
                  mono
                  className="settings-field"
                  value={codexModelDraft}
                  onChange={(e) => setCodexModelDraft(e.target.value)}
                  onBlur={() => {
                    const next = codexModelDraft.trim();
                    if (next !== settings.explainCodexModel) {
                      void updateSettings({ explainCodexModel: next });
                    }
                  }}
                  placeholder="(CLI default)"
                />
              </SettingsRow>
            )}
          </div>

          <div className="explain-prompt-head">
            <label className="k-settings-row-label" htmlFor="explain-prompt">
              Prompt
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPromptDraft(DEFAULT_EXPLAIN_PROMPT)}
              disabled={promptDraft === DEFAULT_EXPLAIN_PROMPT}
            >
              Reset to default
            </Button>
          </div>
          <Textarea
            id="explain-prompt"
            mono
            className="explain-prompt"
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            onBlur={savePrompt}
            spellCheck={false}
          />
          <p className="k-description">
            <span className="k-mono">{"{{context}}"}</span> is replaced with the previous lines
            and <span className="k-mono">{"{{sentence}}"}</span> with the line being explained.
            Saved when the field loses focus. Cached explanations keep their old text; use
            Regenerate in the Explain dialog after editing.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
