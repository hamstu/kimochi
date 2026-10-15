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
import {
  Button,
  Callout,
  IconButton,
  Input,
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SettingsRow,
  SettingsSection,
  isComposing,
} from "@kit";

/** Named snapshots of settings + replacements (not currently mounted). */
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
    <SettingsSection
      title="Preset"
      actions={
        <span className="preset-actions">
          <IconButton label="Import preset from JSON" size="sm" onClick={() => void handleImport()}>
            <Upload />
          </IconButton>
          <IconButton label="Export this preset to JSON" size="sm" onClick={() => void handleExport()}>
            <Download />
          </IconButton>
          <IconButton
            label={
              names.length <= 1
                ? "Can't delete the only preset"
                : armed === "delete"
                  ? `Confirm delete "${active}"`
                  : "Delete this preset"
            }
            variant={armed === "delete" ? "danger" : "ghost"}
            size="sm"
            onClick={() => void handleDelete()}
            disabled={names.length <= 1}
          >
            <Trash2 />
          </IconButton>
        </span>
      }
    >
      <SettingsRow
        label="Active preset"
        description={dirty ? "Unsaved changes." : undefined}
      >
        <SelectRoot value={active} onValueChange={(v) => void handleSelect(v)}>
          <SelectTrigger aria-label="Preset">
            <SelectValue>{active}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {names.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        <Button
          size="sm"
          onClick={() => void handleSaveOver()}
          disabled={!dirty}
          title="Save current settings + replacements into this preset"
        >
          <Save /> Save
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
          <Plus /> Save as…
        </Button>
      </SettingsRow>

      {armed === "switch" && pendingSwitch ? (
        <div className="settings-note">
          <Callout tone="warn">
            <span>
              Unsaved changes to <b>{active}</b>. Switch to <b>{pendingSwitch}</b>?
            </span>
            <span className="preset-actions">
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
              <Button variant="danger" size="sm" onClick={() => void confirmSwitch()}>
                Discard
              </Button>
            </span>
          </Callout>
        </div>
      ) : null}

      {newNameMode ? (
        <SettingsRow label="New preset name" controlId="preset-new-name">
          <Input
            id="preset-new-name"
            className="settings-field"
            value={newName}
            placeholder="Preset name"
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (isComposing(e)) return;
              if (e.key === "Enter") void handleSaveAs();
              if (e.key === "Escape") {
                setNewNameMode(false);
                setNewName("");
              }
            }}
          />
          <Button variant="primary" size="sm" onClick={() => void handleSaveAs()} disabled={!newName.trim()}>
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
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
