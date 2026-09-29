import { useEffect, useState } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import { Button, IconButton, Input, SettingsRow, SettingsSection, Switch } from "@kit";
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
    <SettingsSection
      title="Text replacements"
      description="Pattern rules applied to incoming lines, top to bottom. Drag to reorder."
      actions={
        <Button variant="ghost" size="sm" onClick={() => void addReplacement()}>
          <Plus /> Add replacement
        </Button>
      }
    >
      {rules.length === 0 ? (
        <SettingsRow
          label="No replacements"
          description="Add one to strip stage directions, normalize quotes, etc."
        />
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
            className="k-settings-row replacement-row"
            data-dragging={dragId === r.id ? "" : undefined}
          >
            <GripVertical className="replacement-grip" aria-hidden />
            <Switch
              size="sm"
              aria-label="Enabled"
              checked={r.enabled}
              onCheckedChange={(v) => void updateReplacement(r.id, { enabled: v })}
            />
            <Input
              size="sm"
              mono
              aria-label="Pattern"
              aria-invalid={errored || undefined}
              value={r.pattern}
              onChange={(e) => void updateReplacement(r.id, { pattern: e.target.value })}
              placeholder="pattern"
              className="replacement-pattern"
            />
            <Input
              size="sm"
              mono
              aria-label="Flags"
              value={r.flags}
              onChange={(e) => void updateReplacement(r.id, { flags: e.target.value })}
              placeholder="g"
              className="replacement-flags"
            />
            <Input
              size="sm"
              mono
              aria-label="Replacement"
              value={r.replacement}
              onChange={(e) => void updateReplacement(r.id, { replacement: e.target.value })}
              placeholder="replacement"
              className="replacement-pattern"
            />
            <IconButton label="Remove" size="sm" onClick={() => void removeReplacement(r.id)}>
              <X />
            </IconButton>
          </div>
        );
      })}
    </SettingsSection>
  );
}
