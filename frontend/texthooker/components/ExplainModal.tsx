import { displayHtml } from "../lib/html";
import { useMemo, useSyncExternalStore } from "react";
import { marked } from "marked";
import { RefreshCw } from "lucide-react";
import { Badge, Button, Callout, Dialog, DialogContent, Spinner } from "@kit";
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
    settings.explainProvider === "kimochi"
      ? "Kimochi cloud"
      : settings.explainProvider === "claude"
        ? `Claude · ${settings.explainClaudeModel || "default"}`
        : `Codex${settings.explainCodexModel ? ` · ${settings.explainCodexModel}` : ""}`;

  const busy = state.status === "loading" || state.status === "streaming";

  return (
    <Dialog open onOpenChange={(open) => !open && closeExplain()}>
      <DialogContent
        className="log-explain"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // The sentence is the title. scan-region: shift+hover dictionary scanning works here
        // (the title renders as an h2, which bounds the scan block).
        title={
          <span className="jp-text scan-region log-explain-sentence" lang="ja">
            {state.line.text}
          </span>
        }
        description={
          <span className="log-explain-meta">
            <span>{providerLabel}</span>
            {state.fromCache ? <Badge>Cached</Badge> : null}
          </span>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => regenerateExplain()}
            title="Re-run with the current prompt and model settings"
          >
            <RefreshCw className={busy ? "log-spin" : undefined} />
            Regenerate
          </Button>
        }
      >
        {state.status === "error" ? (
          <Callout tone="danger">
            <span className="log-explain-error">{state.text}</span>
          </Callout>
        ) : state.status === "loading" ? (
          <div className="log-explain-waiting">
            <Spinner label="Waiting" />
            Waiting for{" "}
            {settings.explainProvider === "kimochi"
              ? "Kimochi cloud"
              : settings.explainProvider === "claude"
                ? "Claude"
                : "Codex"}
            …
          </div>
        ) : (
          <>
            <div
              className="explain-markdown scan-region log-explain-body"
              dangerouslySetInnerHTML={{ __html: displayHtml(html) }}
            />
            {state.status === "streaming" ? (
              <span className="log-explain-caret" aria-hidden />
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
