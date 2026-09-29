import { displayHtml } from "../lib/html";
import { useMemo, useSyncExternalStore } from "react";
import { marked } from "marked";
import { RefreshCw, Sparkles, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@texthooker/components/ui/dialog";
import { Button } from "@texthooker/components/ui/button";
import {
  closeExplain,
  getExplainState,
  regenerateExplain,
  subscribeExplainState,
} from "@texthooker/lib/explain";
import { getSettings } from "@texthooker/lib/settings";

export function ExplainModal() {
  const state = useSyncExternalStore(subscribeExplainState, getExplainState);

  const html = useMemo(() => {
    if (!state || state.status === "error" || !state.text) return "";
    return marked.parse(state.text, { breaks: true, async: false });
  }, [state]);

  if (!state) return null;

  const settings = getSettings();
  const providerLabel =
    settings.explainProvider === "claude"
      ? `claude · ${settings.explainClaudeModel || "default"}`
      : `codex${settings.explainCodexModel ? ` · ${settings.explainCodexModel}` : ""}`;

  const busy = state.status === "loading" || state.status === "streaming";

  return (
    <Dialog open onOpenChange={(open) => !open && closeExplain()}>
      {/* Centered via inset-0 + m-auto (not translate -50%) so the box stays
          on whole-pixel boundaries — the transform trick lands on half pixels
          and blurs text. */}
      <DialogContent
        className="inset-0 m-auto flex h-[88vh] w-[92vw] max-w-[68.75rem] flex-col overflow-hidden border border-(--color-border) rounded-lg p-0 shadow-[var(--shadow-pop)]"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Header: the sentence being explained */}
        <div className="flex items-start gap-3 border-b border-(--color-border) bg-(--color-bg-elev) px-5 py-4">
          <Sparkles className="mt-1 h-4 w-4 flex-none text-(--color-accent)" />
          <div className="min-w-0 flex-1">
            <DialogTitle asChild>
              {/* scan-region: shift+hover dictionary scanning works here. The
                  header is one block for the scanner, so wrap it in a <p>. */}
              <div className="jp-text scan-region" lang="ja">
                <p className="text-lg leading-relaxed break-words">
                  {state.line.text}
                </p>
              </div>
            </DialogTitle>
            <div className="mt-1 flex items-center gap-2 text-[0.625rem] text-(--color-text-muted)">
              <span>{providerLabel}</span>
              {state.fromCache ? (
                <span className="rounded border border-(--color-border) px-1 py-px">
                  cached
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-none items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={busy}
              onClick={() => regenerateExplain()}
              title="Re-run with the current prompt and model settings"
            >
              <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
              Regenerate
            </Button>
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </Button>
            </DialogClose>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {state.status === "error" ? (
            <div className="rounded-md border border-(--color-danger) bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger) whitespace-pre-wrap break-words">
              {state.text}
            </div>
          ) : state.status === "loading" ? (
            <div className="flex items-center gap-2 text-sm text-(--color-text-muted)">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-(--color-text-muted) border-t-transparent" />
              Waiting for {settings.explainProvider}…
            </div>
          ) : (
            <>
              <div
                className="explain-markdown scan-region text-sm leading-relaxed"
                dangerouslySetInnerHTML={{ __html: displayHtml(html) }}
              />
              {state.status === "streaming" ? (
                <span className="mt-1 inline-block h-4 w-2 animate-pulse bg-(--color-accent)" />
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
