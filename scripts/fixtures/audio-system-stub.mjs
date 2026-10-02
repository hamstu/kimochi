/** The shape of Yomitan's AudioSystem#_isAudioValid, for host/audio-bridge.js tests. */
export class AudioSystem {
  _isAudioValid(audio, sourceType) {
    return sourceType !== 'jpod101' || (audio.duration !== 5.694694 && audio.duration !== 5.651111)
  }
}
