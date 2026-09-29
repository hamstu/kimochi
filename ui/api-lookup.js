/** Reuses Super Texthooker's native popup for overlay API lookups. */
export async function installApiLookup() {
  const { setEmbeddedEnabled } = await import("/spike/frontend-mode.js");
  const { invoke } = window.__TAURI__.core;
  let settings = await invoke("settings_get", { key: "yomitanSettings" });
  let reader = (await invoke("settings_get", { key: "superTexthooker" })) || {};
  const update = () => setEmbeddedEnabled(settings?.popupType !== "custom-api");
  update();
  await window.__TAURI__.event.listen("settings:changed", ({ payload }) => {
    if (payload.key === "yomitanSettings") {
      settings = payload.value;
      update();
      if (settings?.popupType !== 'custom-api') void invoke('hide_popover');
    }
    if (payload.key === "superTexthooker") reader = payload.value || {};
  });
  let previous = null;
  async function show(event) {
    if (settings?.popupType !== "custom-api") return;
    const target = event.target.closest?.("[data-ocr-word-box]");
    if (
      !target ||
      (event.type === "mousemove" && (!event.shiftKey || target === previous))
    )
      return;
    previous = target;
    const term =
      target.querySelector(".ocr-word-current")?.textContent ||
      target.textContent;
    if (!term?.trim()) return;
    event.stopPropagation();
    try {
      await invoke("show_popover", {
        term: term.trim(),
        cursorX: event.screenX,
        cursorY: event.screenY,
        width: reader.popoverWidth || 480,
        height: reader.popoverHeight || 360,
        baseUrl: settings.customApiUrl ?? "http://localhost:8765",
        focus: event.type === "click",
        sentence: term,
        includeMedia: Boolean(reader.audioEnabled || reader.ankiEnabled),
        audioAutoplay: Boolean(reader.audioEnabled && reader.audioAutoplay),
        audioVolume: reader.audioVolume ?? 0.9,
        ankiConfig: reader.ankiEnabled
          ? {
              ankiConnectUrl: reader.ankiConnectUrl,
              deck: reader.ankiDeckName,
              model: reader.ankiModelName,
              modelFields: reader.ankiModelFields,
              mappings: reader.ankiFieldMappings,
              tags: reader.ankiTags,
            }
          : null,
      });
    } catch (error) {
      console.error("API dictionary popup:", error);
    }
  }
  document.addEventListener("click", show);
  document.addEventListener("mousemove", show);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Shift") previous = null;
  });
}
