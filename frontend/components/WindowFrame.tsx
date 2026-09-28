/** COPY of `src/renderer/src/components/WindowFrame.tsx`. No changes. */
import { Flex } from '@radix-ui/themes'
import style from './WindowFrame.module.css'
import type { JSX, ReactNode } from 'react'

interface WindowFrameProps {
  children: ReactNode
  windowType?: 'app'
  show?: boolean
}

/** Content layout inside a native window. Movement and bounds belong to Electron. */
export default function WindowFrame({
  children,
  show = true,
  windowType
}: WindowFrameProps): JSX.Element | null {
  if (!show) return null
  if (windowType === 'app')
    return (
      <div className={style.frameWrapper}>
        <div className={style.container}>
          <Flex
            direction="column"
            align="center"
            justify="center"
            gap="4"
            style={{ flexGrow: 1 }}
            asChild
          >
            {children}
          </Flex>
        </div>
      </div>
    )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {children}
    </div>
  )
}
