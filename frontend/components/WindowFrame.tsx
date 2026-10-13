/**
 * Content layout inside a native window: a plain full-height column. Movement and bounds belong to
 * the native side, and the chrome to `PanelShell`.
 */
import style from './WindowFrame.module.css'
import type { JSX, ReactNode } from 'react'

interface WindowFrameProps {
  children: ReactNode
  show?: boolean
}

export default function WindowFrame({ children, show = true }: WindowFrameProps): JSX.Element | null {
  if (!show) return null
  return <div className={style.column}>{children}</div>
}
