/** One sentence clip at a time, including while its bytes are still being fetched. */
export type PlaybackResult = 'playing' | 'stopped' | 'unavailable' | 'cancelled'

interface Clip {
  pause(): void
  play(): Promise<void>
  addEventListener(event: 'ended' | 'error', listener: () => void): void
  currentTime: number
  duration: number
}

export function createLineAudioPlayer(
  fetchClip: (uid: string) => Promise<string | null>,
  makeAudio: (base64: string) => Clip,
  changed: () => void
) {
  let request = 0
  let pending: string | null = null
  let playing: { uid: string; audio: Clip } | null = null

  function stop(uid?: string): void {
    if (uid !== undefined && pending !== uid && playing?.uid !== uid) return
    request++
    pending = null
    playing?.audio.pause()
    playing = null
    changed()
  }

  async function toggle(uid: string): Promise<PlaybackResult> {
    const same = playing?.uid === uid || pending === uid
    stop()
    if (same) return 'stopped'
    const ticket = request
    pending = uid
    try {
      const base64 = await fetchClip(uid)
      if (ticket !== request) return 'cancelled'
      pending = null
      if (!base64) return 'unavailable'
      const audio = makeAudio(base64)
      playing = { uid, audio }
      const done = (): void => {
        if (playing?.audio === audio) {
          playing = null
          changed()
        }
      }
      audio.addEventListener('ended', done)
      audio.addEventListener('error', done)
      changed()
      try {
        await audio.play()
      } catch (error) {
        done()
        if (ticket === request) throw error
      }
      return ticket === request ? 'playing' : 'cancelled'
    } catch (error) {
      if (ticket !== request) return 'cancelled'
      throw error
    } finally {
      if (ticket === request) pending = null
    }
  }

  return {
    toggle,
    stop,
    isPlaying: (uid: string | undefined): boolean => Boolean(uid && playing?.uid === uid),
    progress: (uid: string): number | null => {
      if (playing?.uid !== uid) return null
      const { currentTime, duration } = playing.audio
      return duration > 0 && Number.isFinite(duration) ? Math.min(1, currentTime / duration) : 0
    }
  }
}
