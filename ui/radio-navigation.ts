/** Radio groups wrap arrows and put Home/End at the first/last choice. */
export function radioTarget(key: string, index: number, count: number): number | null {
  if (count < 1) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index + count - 1) % count
  return null
}
