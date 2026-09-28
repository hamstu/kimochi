import { currentLines } from './current-lines.js'
import type { ObservedLine } from './observation.js'

/** Readiness per line: unrelated moving text cannot reset a menu item's clock. */
export class StableLineGate {
  private previous: { line: ObservedLine; count: number }[] = []
  private covered: ObservedLine[] = []
  private missing = new Map<ObservedLine, number>()
  observe(lines: ObservedLine[], tolerance: number, required: number): boolean {
    this.covered = this.covered.filter((line) => {
      if (currentLines([line], lines, tolerance).length) {
        this.missing.delete(line)
        return true
      }
      const count = (this.missing.get(line) ?? 0) + 1
      if (count >= 2) {
        this.missing.delete(line)
        return false
      }
      this.missing.set(line, count)
      return true
    })
    this.previous = lines.map((line) => {
      const old = this.previous.find((old) => currentLines([line], [old.line], tolerance).length)
      return { line, count: (old?.count ?? 0) + 1 }
    })
    return this.previous.some(
      ({ line, count }) =>
        count >= required && !currentLines([line], this.covered, tolerance).length
    )
  }
  cover(lines: ObservedLine[] | null): void {
    this.covered = lines ?? []
    this.missing.clear()
  }
  reset(): void {
    this.previous = []
    this.missing.clear()
    this.covered = []
  }
}
