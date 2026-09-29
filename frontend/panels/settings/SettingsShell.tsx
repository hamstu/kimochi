/**
 * Settings window layout: a flush rail of remote-style rows on the left, split from the scrolling
 * page by a hairline. Built on the Radix Tabs primitive for keyboard navigation and ARIA.
 */
import type { ReactNode } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import './settings-shell.css'

export interface SettingsNavItem {
  value: string
  label: string
  icon: ReactNode
}

export function SettingsShell({
  value,
  onValueChange,
  items,
  children
}: {
  value: string
  onValueChange: (value: string) => void
  items: readonly SettingsNavItem[]
  children: ReactNode
}): ReactNode {
  return (
    <Tabs.Root
      orientation="vertical"
      value={value}
      onValueChange={onValueChange}
      className="settings-shell"
      activationMode="manual"
    >
      <Tabs.List className="settings-rail" aria-label="Settings categories">
        {items.map((item) => (
          <Tabs.Trigger key={item.value} value={item.value} className="k-row settings-rail-row">
            {item.icon}
            <span className="k-row-label">{item.label}</span>
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {children}
    </Tabs.Root>
  )
}

/** One settings page. Only the active page mounts unless `forceMount` is set. */
export function SettingsTab({
  value,
  forceMount,
  hidden,
  children
}: {
  value: string
  forceMount?: boolean
  hidden?: boolean
  children: ReactNode
}): ReactNode {
  return (
    <Tabs.Content
      value={value}
      forceMount={forceMount ? true : undefined}
      {...(hidden === undefined ? {} : { hidden })}
      className="settings-page-scroll"
    >
      {children}
    </Tabs.Content>
  )
}
