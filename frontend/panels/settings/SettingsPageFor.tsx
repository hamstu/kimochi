/** One settings page by name, for the Settings window and the main window's Settings view. */
import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import type { SettingsTabName } from "../../bridge/tauri";
const GeneralTab = lazy(() =>
  import("./GeneralTab").then((m) => ({ default: m.GeneralTab })),
);
const SourcesTab = lazy(() =>
  import("./SourcesTab").then((m) => ({ default: m.SourcesTab })),
);
const OcrTab = lazy(() =>
  import("./OcrTab").then((m) => ({ default: m.OcrTab })),
);
const LogTab = lazy(() =>
  import("./LogTab").then((m) => ({ default: m.LogTab })),
);
const DictionaryTab = lazy(() =>
  import("./DictionaryTab").then((m) => ({ default: m.DictionaryTab })),
);
const AssistTab = lazy(() =>
  import("./AssistTab").then((m) => ({ default: m.AssistTab })),
);
const ControlsTab = lazy(() =>
  import("./ControlsTab").then((m) => ({ default: m.ControlsTab })),
);
const AccountTab = lazy(() =>
  import("./AccountTab").then((m) => ({ default: m.AccountTab })),
);

const PAGES: Record<SettingsTabName, ComponentType> = {
  general: GeneralTab,
  sources: SourcesTab,
  ocr: OcrTab,
  log: LogTab,
  dictionary: DictionaryTab,
  assist: AssistTab,
  controls: ControlsTab,
  account: AccountTab,
};

export function SettingsPageFor({ tab }: { tab: SettingsTabName }): ReactNode {
  const Page = PAGES[tab];
  return (
    <Suspense fallback={<div role="status">Loading settings…</div>}>
      <Page />
    </Suspense>
  );
}
