/** Yomitan keeps its body hidden until its backend handshake and page setup finish. */
export function dictionaryPageReady(document: Document | null): boolean {
  return Boolean(document?.body && !document.body.hidden && document.readyState === 'complete')
}
