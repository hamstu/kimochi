type SetupJob = { stage: string } | null

/** Do not reload the backend that owns an unfinished dictionary import. */
export async function waitForDictionarySetup(
  read: () => Promise<SetupJob>,
  waiting: () => void,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 1000))
): Promise<void> {
  for (;;) {
    const job = await read()
    if (!job || job.stage === 'complete' || job.stage === 'failed') return
    waiting()
    await pause()
  }
}
