/** Focused controls use ordinary gamepad snapshots, independently of overlay navigation. */
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useCapabilities } from "../bridge/capabilities";
import {
  onEvent,
  panel,
  hotkeysLoad,
  onSettingsChanged,
} from "../bridge/tauri";
import { useSetting } from "../bridge/useSetting";
import type { GamepadState } from "../bridge/types";
import { installPanelController } from "../../ui/panel-controller.js";

export function usePanelController(label: string): void {
  const capabilities = useCapabilities();
  const gamingMode = capabilities.os === 'linux' && capabilities.session?.compositor?.toLowerCase() === 'gamescope';
  useEffect(() => {
    if (!gamingMode) return;
    const renew = (): void => {
      if (!document.hasFocus() || document.visibilityState === 'hidden') return;
      void invoke('panel_controller_input', { label }).catch((error: unknown) => {
        console.warn('Gaming Mode controls input heartbeat failed', error);
      });
    };
    renew();
    const timer = window.setInterval(renew, 500);
    return () => window.clearInterval(timer);
  }, [gamingMode, label]);
  const [buttons] = useSetting<Record<string, number | null>>(
    "controllerButtons",
    {},
  );
  useEffect(() => {
    const controller = installPanelController(window, {
      onBack: () => {
        void panel(label, "hide").catch(() => undefined);
        return true;
      },
    });
    controller.setButtons(buttons);
    let disposed = false;
    const refreshChord = (): void => {
      void hotkeysLoad()
        .then((hotkeys) => {
          if (disposed) return;
          const binding = hotkeys.openControllerMenu;
          controller.setMenuChord(
            binding?.enabled === false
              ? []
              : (binding?.gamepadButtons ??
                  (Number.isInteger(binding?.gamepadButton)
                    ? [binding.gamepadButton]
                    : [])),
          );
        })
        .catch(() => undefined);
    };
    refreshChord();
    const subscriptions = [
      onSettingsChanged((key) => {
        if (key === "hotkeys" || key.startsWith("hotkeys.")) refreshChord();
      }),
      onEvent<GamepadState & { controlsInputOwner?: boolean }>("gamepad", (payload) => {
        if (gamingMode && payload.controlsInputOwner === false) {
          controller.reset();
          return;
        }
        controller.snapshot(payload);
      }),
      onEvent("controller-nav-cancel", () => controller.reset()),
    ];
    const stops: (() => void)[] = [];
    for (const pending of subscriptions) {
      void pending
        .then((stop) => {
          if (disposed) stop();
          else stops.push(stop);
        })
        .catch(() => undefined);
    }
    return () => {
      disposed = true;
      controller.destroy();
      stops.forEach((stop) => stop());
    };
  }, [label, buttons, gamingMode]);
}
