import { useEffect, useState } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import { Button } from "@texthooker/components/ui/button";
import { Input } from "@texthooker/components/ui/input";
import { Switch } from "@texthooker/components/ui/switch";
import {
  addReplacement,
  getReplacements,
  isPatternErrored,
  removeReplacement,
  reorderReplacement,
  subscribeReplacements,
  updateReplacement,
} from "@texthooker/lib/replacements";
import type { Replacement } from "@texthooker/lib/types";
import { cn } from "@texthooker/lib/utils";

export function ReplacementsEditor() {
  const [rules, setRules] = useState<Replacement[]>(getReplacements());
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => {
    return subscribeReplacements(setRules);
  }, []);

  const onDragStart = (id: string) => (e: React.DragEvent) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const onDrop = (targetIdx: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragId) return;
    reorderReplacement(dragId, targetIdx);
    setDragId(null);
  };

  return (
    <div className="space-y-1.5">
      {rules.length === 0 ? (
        <div className="text-[0.625rem] text-(--color-text-muted) italic">
          No replacements. Add one to strip stage directions, normalize quotes,
          etc.
        </div>
      ) : null}

      {rules.map((r, idx) => {
        const errored = isPatternErrored(r);
        return (
          <div
            key={r.id}
            draggable
            onDragStart={onDragStart(r.id)}
            onDragOver={onDragOver}
            onDrop={onDrop(idx)}
            onDragEnd={() => setDragId(null)}
            className={cn(
              "flex items-center gap-1.5 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-1.5 py-1",
              dragId === r.id && "opacity-50",
              errored && "border-(--color-danger)",
            )}
          >
            <GripVertical className="h-3.5 w-3.5 cursor-grab text-(--color-text-muted) shrink-0" />
            <Switch
              checked={r.enabled}
              onCheckedChange={(v) => updateReplacement(r.id, { enabled: v })}
            />
            <Input
              type="text"
              spellCheck={false}
              value={r.pattern}
              onChange={(e) =>
                updateReplacement(r.id, { pattern: e.target.value })
              }
              placeholder="pattern"
              className={cn(
                "flex-1 min-w-0 rounded border border-(--color-border) bg-(--color-bg) px-1.5 py-0.5 font-mono text-[0.6875rem]",
                errored && "text-(--color-danger)",
              )}
            />
            <Input
              type="text"
              spellCheck={false}
              value={r.flags}
              onChange={(e) =>
                updateReplacement(r.id, { flags: e.target.value })
              }
              placeholder="g"
              className="w-[2.75rem] rounded border border-(--color-border) bg-(--color-bg) px-1.5 py-0.5 font-mono text-[0.6875rem]"
            />
            <Input
              type="text"
              spellCheck={false}
              value={r.replacement}
              onChange={(e) =>
                updateReplacement(r.id, { replacement: e.target.value })
              }
              placeholder="replacement"
              className="flex-1 min-w-0 rounded border border-(--color-border) bg-(--color-bg) px-1.5 py-0.5 font-mono text-[0.6875rem]"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeReplacement(r.id)}
              title="Remove"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}

      <Button
        variant="ghost"
        size="sm"
        onClick={() => addReplacement()}
        className="w-full justify-center"
      >
        <Plus className="h-3.5 w-3.5" /> Add replacement
      </Button>
    </div>
  );
}
