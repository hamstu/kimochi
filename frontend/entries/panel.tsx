/**
 * Panel window entry.
 *
 * Electron used one `panel.html` for every panel window and switched on the snapshot's `kind`
 * (`windows/panel/PanelApp.tsx`). Tauri windows carry a label instead, so this switches on
 * `getCurrentWindow().label` — the same single-shell arrangement.
 */
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { reportError, reportUncaughtErrors } from "./reportErrors";
import "@radix-ui/themes/styles.css";
import "../kit/kit.css";
import "../texthooker/App.css";
import "../shell/panel.css";
import Providers from "./providers";
import PanelShell from "../shell/PanelShell";
import MainPanel from "../main/MainPanel";
import DictionaryPanelShell from "../shell/DictionaryPanelShell";
import { preloadPanelDictionary } from "../shell/panelDictionary";

import { SettingsPanel, DiagnosticsPanel, DictionarySettingsPanel, SyncLogPanel } from "../panels/deferred";

/** Titles and components, matching `PanelApp.tsx`'s `titles` / `components` maps. */
const PANELS = {
  log: { title: "Kimochi", Component: MainPanel, hideTitle: true },
  settings: { title: "Settings", Component: SettingsPanel, hideTitle: false },
  diagnostics: {
    title: "Diagnostics",
    Component: DiagnosticsPanel,
    hideTitle: true,
  },
  // Sync's activity, from Settings → Account → Sync.
  "sync-log": { title: "Sync log", Component: SyncLogPanel, hideTitle: false },
  // Titled by the engine; see `DictionaryPanelShell`.
  dictionary: {
    title: "Dictionary",
    Component: DictionarySettingsPanel,
    hideTitle: false,
  },
} as const;

type KnownLabel = keyof typeof PANELS;

const label = getCurrentWindow().label;

reportUncaughtErrors(label);
const known = (label in PANELS ? label : "log") as KnownLabel;
const { title, Component, hideTitle } = PANELS[known];

if (!(label in PANELS)) {
  console.error(
    `[panel] window label "${label}" has no panel; falling back to the main window. Known labels: ${Object.keys(PANELS).join(", ")}`,
  );
}

// The main window (the Log) hosts dictionary lookups over scanned text. The real backend lives in the
// overlay (one IndexedDB writer), so for Yomitan the overlay workstream ships a relay module that
// must publish this window's native label and install its chrome.* host BEFORE React mounts; for
// Hachidori and 10ten the injected extension host is already in place. `start()` is called
// separately, after the log content is in the DOM — see `usePanelDictionary` in the Log panel.
if (known === "log") {
  await preloadPanelDictionary(label);
}

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => reportError(label, "render", error),
}).render(
  <StrictMode>
    <Providers>
      <Suspense fallback={<div role="status">Loading…</div>}>
        {known === "dictionary" ? (
          // The dictionary window's title follows the active engine.
          <DictionaryPanelShell label={label} hideTitle={hideTitle}>
            <Component />
          </DictionaryPanelShell>
        ) : (
          <PanelShell label={label} title={title} hideTitle={hideTitle}>
            <Component />
          </PanelShell>
        )}
      </Suspense>
    </Providers>
  </StrictMode>,
);
