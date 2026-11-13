import { useCallback } from 'react'
import { call } from '../bridge'
import type { LineSource } from '../lib/types'
export function useIngest() {
  return useCallback(
    (text: string, source: LineSource, ts?: number, ingestId?: string, replaces?: string) =>
      call('host', 'ingest', [text, source, ts, ingestId, undefined, replaces]),
    []
  )
}
