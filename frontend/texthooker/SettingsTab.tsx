import { useEffect, useState } from "react";
import { initializeClient, subscribe } from "./bridge";
import { loadSettings, onSettingsChange } from "./lib/settings";
import { SettingsPanel } from "./components/SettingsPanel";
import { EditEntryModal } from "./components/EditEntryModal";
import { onEditModalRequest } from "./lib/editModal";
import { SETTINGS_DEFAULTS } from "./lib/types";
import "./settings.css";
export default function TexthookerSettingsTab() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const fail = (event: PromiseRejectionEvent) =>
      setError(String(event.reason));
    window.addEventListener("unhandledrejection", fail);
    return () => window.removeEventListener("unhandledrejection", fail);
  }, []);

  const [settings, setSettings] = useState(SETTINGS_DEFAULTS);
  const [edit, setEdit] = useState<string | null>(null);
  const [, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all([initializeClient(), loadSettings()])
      .then(([, value]) => {
        if (active) {
          setSettings(value);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    const offSettings = onSettingsChange(setSettings);
    const offEdit = onEditModalRequest(setEdit);
    const offSnapshot = subscribe(() => refresh((n) => n + 1));
    return () => {
      active = false;
      offSettings();
      offEdit();
      offSnapshot();
    };
  }, []);
  if (!ready)
    return (
      <div role="status" className="p-4">
        {error || "Loading Texthooker settings…"}
      </div>
    );
  return (
    <div className="texthooker texthooker-settings-page p-4">
      <div role="alert">{error}</div>
      <SettingsPanel open settings={settings} />
      <EditEntryModal entryId={edit} onClose={() => setEdit(null)} />
    </div>
  );
}
