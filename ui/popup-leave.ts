/**
 * When the overlay's dictionary pop-up should close because the pointer has left it.
 *
 * Yomitan keeps its pop-up until another lookup or a click, and over a game that click also
 * reaches the game (a visual novel advances on it). On Windows a hover no longer takes the
 * keyboard either (mouseguard.rs), so Escape goes to the game too. The overlay therefore closes
 * the pop-up itself once the pointer has been off every word and off the pop-up for `graceMs`:
 * long enough to cross the gap between a word and its pop-up, short enough to read as "it went
 * away when I moved on".
 */
export interface LeaveRect { x: number; y: number; width: number; height: number }

export class PopupLeave {
  private awaySince: number | null = null

  constructor(readonly graceMs = 600) {}

  /** True exactly once, when the open pop-up should close. `rects` are the words and the pop-up. */
  update(now: number, pointer: { x: number; y: number } | null, rects: LeaveRect[], popupOpen: boolean): boolean {
    const inside = pointer !== null && rects.some((r) =>
      pointer.x >= r.x && pointer.y >= r.y && pointer.x < r.x + r.width && pointer.y < r.y + r.height)
    if (!popupOpen || inside) {
      this.awaySince = null
      return false
    }
    this.awaySince ??= now
    if (now - this.awaySince < this.graceMs) return false
    this.awaySince = null
    return true
  }

  /** How long until `update` could next say "close", or null when nothing is pending. */
  remaining(now: number): number | null {
    return this.awaySince === null ? null : Math.max(0, this.graceMs - (now - this.awaySince))
  }
}
