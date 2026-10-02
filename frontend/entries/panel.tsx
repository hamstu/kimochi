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
import { invoke } from "@tauri-apps/api/core";
import "@radix-ui/themes/styles.css";
import "../kit/kit.css";
import "../texthooker/App.css";
import "../shell/panel.css";
import Providers from "./providers";
import PanelShell from "../shell/PanelShell";
import MainPanel from "../main/MainPanel";
import SettingsPanel from "../panels/SettingsPanel";
import DiagnosticsPanel from "../panels/DiagnosticsPanel";
import YomitanSettingsPanel from "../panels/YomitanSettingsPanel";
import { preloadPanelYomitan } from "../shell/panelYomitan";

/** Titles and components, matching `PanelApp.tsx`'s `titles` / `components` maps. */
const PANELS = {
  log: { title: "Kimochi", Component: MainPanel, hideTitle: true },
  settings: { title: "Settings", Component: SettingsPanel, hideTitle: false },
  diagnostics: { title: "Diagnostics", Component: DiagnosticsPanel, hideTitle: true },
  yomitan: { title: "Yomitan settings", Component: YomitanSettingsPanel, hideTitle: false },
} as const;

type KnownLabel = keyof typeof PANELS;

const label = getCurrentWindow().label;

// Panel windows have no devtools open in ordinary use: an uncaught error (a blank window) goes to
// the app's diagnostics record, as the Yomitan relay's own checks do.
const reportError = (kind: string, error: unknown): void => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  void invoke("report", {
    value: { check: "panel-error", window: label, kind, message: message.slice(0, 2000) },
  }).catch(() => undefined);
};
window.addEventListener("error", (event) => reportError("error", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => reportError("rejection", event.reason));
const known = (label in PANELS ? label : "log") as KnownLabel;
const { title, Component, hideTitle } = PANELS[known];

if (!(label in PANELS)) {
  console.error(
    `[panel] window label "${label}" has no panel; falling back to the main window. Known labels: ${Object.keys(PANELS).join(", ")}`,
  );
}

// The main window (the Log) hosts built-in Yomitan lookups over scanned text. The real backend lives in the
// overlay (one IndexedDB writer), so the overlay workstream ships a relay module that must publish
// this window's native label and install its chrome.* host BEFORE React mounts. `start()` is called
// separately, after the log content is in the DOM — see `usePanelYomitan` in the Log panel.
if (known === "log") {
  await preloadPanelYomitan(label);
}

createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => reportError("render", error),
}).render(
  <StrictMode>
    <Providers>
      <PanelShell label={label} title={title} hideTitle={hideTitle}>
        <Component />
      </PanelShell>
    </Providers>
  </StrictMode>,
);
