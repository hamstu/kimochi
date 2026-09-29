import { useCallback } from "react";
import { call } from "../bridge";
import type { LineSource } from "../lib/types";
export function useIngest() {
  return useCallback(
    (text: string, source: LineSource, ts?: number) =>
      call("host", "ingest", [text, source, ts]),
    [],
  );
}
