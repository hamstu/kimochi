/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@texthooker/components/ui/dialog";
import { Button } from "@texthooker/components/ui/button";
import { Input } from "@texthooker/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@texthooker/components/ui/select";
import { updateSettings } from "@texthooker/lib/settings";
import { DEFAULT_EXPLAIN_PROMPT } from "@texthooker/lib/types";
import type { ExplainProvider, Settings } from "@texthooker/lib/types";

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
        className="left-1/2 right-auto top-1/2 bottom-auto -translate-x-1/2 -translate-y-1/2 flex max-h-[88vh] w-[45rem] max-w-[calc(100vw-48px)] flex-col border border-(--color-border) rounded-lg shadow-[var(--shadow-pop)]"
        aria-describedby={undefined}
      >
        <div className="mb-3 flex items-center justify-between">
          <DialogTitle className="text-sm font-semibold">
            Explain settings
          </DialogTitle>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </DialogClose>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto text-xs">
          <div className="flex items-center justify-between gap-3">
            <label className="text-(--color-text)">Provider</label>
            <Select
              value={settings.explainProvider}
              onValueChange={(v) =>
                void updateSettings({ explainProvider: v as ExplainProvider })
              }
            >
              <SelectTrigger className="w-[11.25rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="codex">Codex CLI</SelectItem>
                <SelectItem value="claude">Claude CLI</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {settings.explainProvider === "claude" ? (
            <div className="flex items-center justify-between gap-3">
              <label className="text-(--color-text)">Claude model</label>
              <Select
                value={settings.explainClaudeModel}
                onValueChange={(v) =>
                  void updateSettings({ explainClaudeModel: v })
                }
              >
                <SelectTrigger className="w-[11.25rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLAUDE_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <label className="text-(--color-text)">Codex model</label>
              <Input
                type="text"
                value={codexModelDraft}
                onChange={(e) => setCodexModelDraft(e.target.value)}
                onBlur={() => {
                  const next = codexModelDraft.trim();
                  if (next !== settings.explainCodexModel) {
                    void updateSettings({ explainCodexModel: next });
                  }
                }}
                placeholder="(CLI default)"
                className="w-[11.25rem] rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs"
              />
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-(--color-text)">Prompt</label>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[0.625rem]"
                onClick={() => setPromptDraft(DEFAULT_EXPLAIN_PROMPT)}
                disabled={promptDraft === DEFAULT_EXPLAIN_PROMPT}
              >
                Reset to default
              </Button>
            </div>
            <textarea
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              onBlur={savePrompt}
              spellCheck={false}
              className="min-h-[20rem] flex-1 resize-y rounded-md border border-(--color-border) bg-(--color-bg-elev) p-2.5 font-mono text-[0.6875rem] leading-relaxed"
            />
            <p className="text-[0.625rem] text-(--color-text-muted)">
              {"{{context}}"} is replaced with the previous lines and{" "}
              {"{{sentence}}"} with the line being explained. Saved when the
              field loses focus. Already-cached explanations keep their old text
              — use Regenerate in the Explain dialog after editing.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
