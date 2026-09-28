/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS instrumentation. */
export function observeFrame(win, hub) {
  const NativeWorker = win.Worker
  win.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options)
      this.spikeUrl = new URL(url, win.location.href).pathname
      let last = 0
      this.addEventListener('message', ({ data }) => {
        if (!this.spikeImportStarted) return
        if (data.action === 'progress') {
          if (data.params.args?.[0]?.nextStep || performance.now() - last > 1000) {
            hub.log({
              check: 'import-progress',
              elapsedMs: performance.now() - this.spikeImportStarted,
              progress: data.params
            })
            last = performance.now()
          }
        } else if (data.action === 'complete') {
          hub.log({
            check: 'import-complete',
            ms: performance.now() - this.spikeImportStarted,
            result: data.params
          })
          hub.lastImport = data.params
        }
      })
      this.addEventListener('error', (e) =>
        hub.log({ check: 'worker-error', url: this.spikeUrl, message: e.message })
      )
    }
    postMessage(message, transfer) {
      if (message.action === 'importDictionary') {
        this.spikeImportStarted = performance.now()
        hub.log({
          check: 'import-start',
          bytes: message.params.archiveContent.byteLength,
          details: message.params.details
        })
        super.postMessage(message, transfer)
        hub.log({
          check: 'archive-transfer',
          detached: message.params.archiveContent.byteLength === 0
        })
      } else super.postMessage(message, transfer)
    }
    terminate() {
      if (this.spikeImportStarted) hub.log({ check: 'import-worker-terminated' })
      super.terminate()
    }
  }
}
