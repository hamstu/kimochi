/**
 * Panel window entry.
 *
 * Electron used one `panel.html` for every panel window and switched on the snapshot's `kind`
 * (`windows/panel/PanelApp.tsx`). Tauri windows carry a label instead, so this switches on
 * `getCurrentWindow().label` — the same single-shell arrangement.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@radix-ui/themes/styles.css";
import "../texthooker/App.css";
import "../shell/panel.css";
import Providers from "./providers";
import PanelShell from "../shell/PanelShell";
import ControllerPanel from "../panels/ControllerPanel";
import SettingsPanel from "../panels/SettingsPanel";
import LogPanel from "../panels/LogPanel";
import NotebookPanel from "../panels/NotebookPanel";
import CapturePanel from "../panels/CapturePanel";
import DebugPanel from "../panels/DebugPanel";
import CaptureDebugPanel from "../panels/CaptureDebugPanel";
import { preloadPanelYomitan } from "../shell/panelYomitan";

/** Titles and components, matching `PanelApp.tsx`'s `titles` / `components` maps. */
const PANELS = {
  controller: { title: "Kimochi", Component: ControllerPanel, mini: true },
  settings: { title: "Settings", Component: SettingsPanel, mini: false },
  log: { title: "Log", Component: LogPanel, mini: false },
  notebook: { title: "Notebook", Component: NotebookPanel, mini: false },
  capture: { title: "Capture Preview", Component: CapturePanel, mini: false },
  debug: { title: "Debug Info", Component: DebugPanel, mini: false },
  stream: { title: "Capture Debug", Component: CaptureDebugPanel, mini: false },
} as const;

type KnownLabel = keyof typeof PANELS;

const label = getCurrentWindow().label;
const known = (label in PANELS ? label : "controller") as KnownLabel;
const { title, Component, mini } = PANELS[known];

if (!(label in PANELS)) {
  console.error(
    `[panel] window label "${label}" has no panel; falling back to the controller. Known labels: ${Object.keys(PANELS).join(", ")}`,
  );
}

// The Log window hosts built-in Yomitan lookups over scanned text. The real backend lives in the
// overlay (one IndexedDB writer), so the overlay workstream ships a relay module that must publish
// this window's native label and install its chrome.* host BEFORE React mounts. `start()` is called
// separately, after the log content is in the DOM — see `usePanelYomitan` in the Log panel.
if (known === "log") {
  await preloadPanelYomitan(label);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <PanelShell label={label} title={title} mini={mini}>
        <Component />
      </PanelShell>
    </Providers>
  </StrictMode>,
);
