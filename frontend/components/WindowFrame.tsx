/**
 * Content layout inside a native window. Movement and bounds belong to the native side.
 *
 * `windowType="app"` is the framed look of the transparent onboarding window: a rounded window
 * ground inset from the transparent edge so its shadow has room. Every other window uses the
 * plain full-height column.
 */
import style from './WindowFrame.module.css'
import type { JSX, ReactNode } from 'react'

interface WindowFrameProps {
  children: ReactNode
  windowType?: 'app'
  show?: boolean
}

export default function WindowFrame({
  children,
  show = true,
  windowType
}: WindowFrameProps): JSX.Element | null {
  if (!show) return null
  if (windowType === 'app')
    return (
      <div className={style.frameWrapper}>
        <div className={style.container}>{children}</div>
      </div>
    )
  return <div className={style.column}>{children}</div>
}
