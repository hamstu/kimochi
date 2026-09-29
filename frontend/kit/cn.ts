import { clsx, type ClassValue } from 'clsx'

export const cn = (...inputs: ClassValue[]): string => clsx(inputs)

/** Portal target: the Radix theme root, so portalled content inherits theme class and tokens. */
export const portalRoot = (): HTMLElement | undefined =>
  (document.querySelector('.radix-themes') as HTMLElement | null) ?? undefined
