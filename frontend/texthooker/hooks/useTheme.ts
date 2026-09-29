import { useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import type { ResolvedTheme, ThemePref } from "@texthooker/lib/types";

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return pref;
}

/**
 * Applies `data-theme` to the document root based on the user's preference.
 * Also broadcasts the resolved theme so the popover window can mirror it.
 */
export function useTheme(pref: ThemePref) {
  useEffect(() => {
    const apply = (resolved: ResolvedTheme) => {
      document.documentElement.dataset.theme = resolved;
      void emit("popover:theme", resolved);
    };

    apply(resolve(pref));

    if (pref !== "system") return;

    // Subscribe to system changes only while in system mode.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply(resolve("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);
}
