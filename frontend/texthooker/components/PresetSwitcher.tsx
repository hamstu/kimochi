import { useEffect, useState } from "react";
import { Download, Plus, Save, Trash2, Upload } from "lucide-react";
import {
  applyPreset,
  deletePreset,
  exportActiveToFile,
  importFromFile,
  isDirty,
  saveCurrentAs,
  saveOverActive,
  subscribePresets,
} from "@texthooker/lib/presets";
import { onSettingsChange } from "@texthooker/lib/settings";
import { subscribeReplacements } from "@texthooker/lib/replacements";
import { Button } from "@texthooker/components/ui/button";
import { Input } from "@texthooker/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@texthooker/components/ui/select";

export function PresetSwitcher() {
  const [active, setActive] = useState("Default");
  const [names, setNames] = useState<string[]>(["Default"]);
  const [dirty, setDirty] = useState(false);
  const [newNameMode, setNewNameMode] = useState(false);
  const [newName, setNewName] = useState("");
  const [armed, setArmed] = useState<null | "delete" | "switch">(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);

  // Subscribe to presets + anything that affects dirty state.
  useEffect(() => {
    return subscribePresets((s) => {
      setActive(s.active);
      setNames(Object.keys(s.presets));
      setDirty(isDirty());
    });
  }, []);
  useEffect(() => onSettingsChange(() => setDirty(isDirty())), []);
  useEffect(() => subscribeReplacements(() => setDirty(isDirty())), []);

  const handleSelect = async (next: string) => {
    if (next === active) return;
    if (dirty) {
      setArmed("switch");
      setPendingSwitch(next);
      return;
    }
    await applyPreset(next);
  };

  const confirmSwitch = async () => {
    if (!pendingSwitch) return;
    await applyPreset(pendingSwitch);
    setArmed(null);
    setPendingSwitch(null);
  };

  const handleSaveOver = async () => {
    await saveOverActive();
  };

  const handleSaveAs = async () => {
    const ok = await saveCurrentAs(newName);
    if (ok) {
      setNewNameMode(false);
      setNewName("");
    }
  };

  const handleDelete = async () => {
    if (armed !== "delete") {
      setArmed("delete");
      return;
    }
    await deletePreset(active);
    setArmed(null);
  };

  const handleExport = async () => {
    await exportActiveToFile();
  };

  const handleImport = async () => {
    const imported = await importFromFile();
    if (imported) {
      await applyPreset(imported);
    }
  };

  return (
    <div className="border-b border-(--color-border) mb-3 pb-3 space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[0.6875rem] uppercase tracking-wider text-(--color-text-dim) shrink-0">
          Preset
        </span>
        <Select value={active} onValueChange={handleSelect}>
          <SelectTrigger className="flex-1">
            <SelectValue>
              {active}
              {dirty ? (
                <span className="ml-1 text-(--color-warn)">*</span>
              ) : null}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {names.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {armed === "switch" && pendingSwitch ? (
        <div className="flex items-center justify-between gap-2 rounded-sm bg-(--color-warn)/10 px-2 py-1.5 text-[0.6875rem] text-(--color-warn)">
          <span>
            Unsaved changes to <b>{active}</b>. Switch to <b>{pendingSwitch}</b>
            ?
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setArmed(null);
                setPendingSwitch(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={confirmSwitch}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-1.5">
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSaveOver}
            disabled={!dirty}
            title="Save current settings + replacements into this preset"
          >
            <Save className="h-3 w-3" /> Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setNewNameMode(true);
              setNewName(active);
            }}
            title="Save as a new preset"
          >
            <Plus className="h-3 w-3" /> Save as…
          </Button>
        </div>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleImport}
            title="Import preset from JSON"
          >
            <Upload className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExport}
            title="Export this preset to JSON"
          >
            <Download className="h-3 w-3" />
          </Button>
          <Button
            variant={armed === "delete" ? "danger" : "ghost"}
            size="sm"
            onClick={handleDelete}
            disabled={names.length <= 1}
            title={
              names.length <= 1
                ? "Can't delete the only preset"
                : armed === "delete"
                  ? `Confirm delete "${active}"`
                  : "Delete this preset"
            }
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {newNameMode ? (
        <div className="flex items-center gap-1.5">
          <Input
            type="text"
            value={newName}
            placeholder="Preset name"
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSaveAs();
              if (e.key === "Escape") {
                setNewNameMode(false);
                setNewName("");
              }
            }}
            className="flex-1 rounded border border-(--color-border) bg-(--color-bg-elev) px-1.5 py-0.5 text-xs"
          />
          <Button
            variant="default"
            size="sm"
            onClick={handleSaveAs}
            disabled={!newName.trim()}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setNewNameMode(false);
              setNewName("");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}
