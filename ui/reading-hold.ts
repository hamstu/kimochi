/** Keep an automatic overlay stable until both its text and popup have been left. */
export interface ReadingRect { x: number; y: number; width: number; height: number }
export class ReadingHold {
  private anchor: ReadingRect | null = null
  update(pointer: { x: number; y: number } | null, rects: ReadingRect[], popup: boolean): boolean {
    const inside = (r: ReadingRect): boolean => pointer !== null &&
      pointer.x >= r.x && pointer.y >= r.y && pointer.x < r.x + r.width && pointer.y < r.y + r.height
    // Keep the original hovered region through proximity/selection styling changes.
    if (!this.anchor || !inside(this.anchor)) this.anchor = rects.find(inside) ?? null
    return popup || this.anchor !== null
  }
  reset(): void { this.anchor = null }
}
