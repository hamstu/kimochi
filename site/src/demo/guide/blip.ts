/** The guide's typing voice: a short, soft blip, a little different each time. */
let ctx: AudioContext | null = null

export function blip(): void {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(820 + Math.random() * 180, now)
    osc.frequency.exponentialRampToValueAtTime(620, now + 0.05)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.07)
  } catch {
    // No Web Audio: a silent guide.
  }
}
