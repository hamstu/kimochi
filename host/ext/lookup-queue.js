/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/** Bound interactive lookups before they cross IPC or enter the engine's serial worker. */
export function createLookupQueue(send) {
  let running = false
  let waiting = null
  let closed = false
  const superseded = () => Error('Lookup superseded by a newer word')
  const run = async (job) => {
    running = true
    try {
      job.resolve(await send(job.request))
    } catch (error) {
      job.reject(error)
    } finally {
      running = false
      const next = waiting
      waiting = null
      if (next) void run(next)
    }
  }
  return {
    submit(request) {
      if (closed) return Promise.reject(Error('Extension context disconnected'))
      return new Promise((resolve, reject) => {
        const job = { request, resolve, reject }
        if (!running) void run(job)
        else {
          waiting?.reject(superseded())
          waiting = job
        }
      })
    },
    close() {
      closed = true
      waiting?.reject(Error('Extension context disconnected'))
      waiting = null
    }
  }
}
