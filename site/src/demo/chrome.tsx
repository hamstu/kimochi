/**
 * Platform dressing for the desktop stage. Kimochi's own windows are undecorated (the app draws its
 * title bar on every OS), so the Log frame only changes shape; the game is an ordinary decorated
 * window, so it gets the platform's real title bar.
 */
import type { ReactNode } from 'react'
import type { Platform } from './env'

export type DesktopPlatform = Exclude<Platform, 'deck'>

/** Outer frame classes for a window on each platform: corner radius and edge. */
export const WINDOW_SHAPE: Record<DesktopPlatform, string> = {
  macos: 'rounded-[10px] shadow-frame ring-1 ring-black/15',
  windows: 'rounded-none shadow-frame ring-1 ring-black/25',
  linux: 'rounded-[12px] shadow-frame ring-1 ring-black/20'
}

function Traffic() {
  return (
    <span className="flex gap-[7px]" aria-hidden="true">
      <span className="size-3 rounded-full kd-tl-close ring-1 ring-black/10" />
      <span className="size-3 rounded-full kd-tl-min ring-1 ring-black/10" />
      <span className="size-3 rounded-full kd-tl-max ring-1 ring-black/10" />
    </span>
  )
}

function Caption() {
  const box = 'grid h-full w-11 place-items-center text-ink-2'
  return (
    <span className="flex h-full" aria-hidden="true">
      <span className={box}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" /></svg>
      </span>
      <span className={box}>
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
      </span>
      <span className={box}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" /></svg>
      </span>
    </span>
  )
}

function GnomeClose() {
  return (
    <span className="grid size-6 place-items-center rounded-full bg-hover text-ink" aria-hidden="true">
      <svg width="8" height="8" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
    </span>
  )
}

/** The game window's title bar. */
export function TitleBar({ platform, title, icon }: { platform: DesktopPlatform; title: string; icon: ReactNode }) {
  if (platform === 'macos')
    return (
      <div className="relative flex h-7 items-center bg-bar px-3 text-[12px] font-semibold text-ink-2">
        <Traffic />
        <span className="absolute inset-x-20 truncate text-center">{title}</span>
      </div>
    )
  if (platform === 'windows')
    return (
      <div className="flex h-8 items-center bg-bar pl-3 text-[12px] text-ink">
        <span className="mr-2 flex">{icon}</span>
        <span className="flex-1 truncate">{title}</span>
        <Caption />
      </div>
    )
  return (
    <div className="relative flex h-[38px] items-center justify-end bg-bar px-2 text-[13px] font-semibold text-ink">
      <span className="absolute inset-x-12 truncate text-center">{title}</span>
      <GnomeClose />
    </div>
  )
}

/** A thin desktop strip so each platform reads at a glance (menu bar, taskbar, GNOME top bar). */
export function DesktopBar({ platform }: { platform: DesktopPlatform }) {
  if (platform === 'macos')
    return (
      <div className="flex h-6 shrink-0 items-center gap-4 bg-bar/80 px-4 text-[11px] text-ink-2 backdrop-blur" aria-hidden="true">
        <span className="font-semibold text-ink">Kimochi</span>
        <span>File</span>
        <span>Edit</span>
        <span>Window</span>
        {/* Room on the right for the demo's maximise button. */}
        <span className="mr-6 ml-auto tnum">9:41</span>
      </div>
    )
  if (platform === 'linux')
    return (
      <div className="relative flex h-6 shrink-0 items-center kd-gnome-bar px-3 text-[11px] font-semibold text-white/90" aria-hidden="true">
        <span className="flex gap-1">
          <span className="h-1.5 w-4 rounded-full bg-white/90" />
          <span className="size-1.5 rounded-full bg-white/45" />
          <span className="size-1.5 rounded-full bg-white/45" />
        </span>
        <span className="absolute left-1/2 -translate-x-1/2 tnum">Thu 21:41</span>
      </div>
    )
  return null
}

/** Windows 11 taskbar along the bottom. */
export function Taskbar() {
  return (
    <div className="flex h-8 shrink-0 items-center justify-center gap-1.5 border-t border-hairline bg-bar/85 backdrop-blur" aria-hidden="true">
      <span className="grid size-6 place-items-center">
        <svg width="14" height="14" viewBox="0 0 16 16" className="text-accent-ink" fill="currentColor">
          <rect width="7.4" height="7.4" />
          <rect x="8.6" width="7.4" height="7.4" />
          <rect y="8.6" width="7.4" height="7.4" />
          <rect x="8.6" y="8.6" width="7.4" height="7.4" />
        </svg>
      </span>
      <span className="size-6 rounded-sm bg-hover" />
      <span className="relative grid size-6 place-items-center rounded-sm bg-hover">
        <span className="size-3 rounded-[3px] kd-game-icon" />
        <span className="absolute -bottom-0.5 h-0.5 w-2 rounded-full bg-accent" />
      </span>
      <span className="relative grid size-6 place-items-center rounded-sm bg-hover">
        <span className="size-3 rounded-full bg-accent" />
        <span className="absolute -bottom-0.5 h-0.5 w-2 rounded-full bg-accent" />
      </span>
    </div>
  )
}
