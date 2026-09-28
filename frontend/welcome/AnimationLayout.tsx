/**
 * COPY of `src/renderer/src/components/AnimationLayout.tsx`.
 * Delta: the transition object is `as const` so the original's `as any` cast is unnecessary. Same
 * values, same animation.
 */
import type { JSX } from 'react'
import { Outlet, useLocation } from 'react-router'
import { motion } from 'motion/react'

const pageVariants = {
  initial: {
    opacity: 0
  },
  in: {
    opacity: 1
  },
  out: {
    opacity: 0
  }
}

const pageTransition = {
  type: 'tween',
  ease: 'linear',
  duration: 0.25
} as const

function AnimationLayout(): JSX.Element {
  const { pathname } = useLocation()
  return (
    <motion.div
      key={pathname}
      initial="initial"
      animate="in"
      variants={pageVariants}
      transition={pageTransition}
    >
      <Outlet />
    </motion.div>
  )
}

export default AnimationLayout
