/**
 * The main window's lazy views (the Notebook and the Anki cards). They stay out of the startup
 * bundle, but are fetched as soon as the window has shown its first content and gone idle, so
 * opening their tab later renders at once instead of behind a loading state.
 */
import type { NotebookPanel } from '@texthooker/components/NotebookPanel'
import type { AnkiPanel } from './AnkiPanel'

interface Views {
  notebook: typeof NotebookPanel
  anki: typeof AnkiPanel
}
export type LazyView = keyof Views
type ViewModule<V extends LazyView> = Promise<{ default: Views[V] }>

const LOADERS: { [V in LazyView]: () => ViewModule<V> } = {
  notebook: () => import('@texthooker/components/NotebookPanel').then((m) => ({ default: m.NotebookPanel })),
  anki: () => import('./AnkiPanel').then((m) => ({ default: m.AnkiPanel }))
}

// One request per view, shared by `lazy` and the preload; and the views that have arrived.
const pending: { [V in LazyView]?: ViewModule<V> } = {}
const loaded: Partial<Views> = {}

/** A view that has already arrived, to render without suspending; otherwise undefined. */
export function loadedView<V extends LazyView>(view: V): Views[V] | undefined {
  return loaded[view]
}

/** A view's module, fetched once (a failed fetch is retried by the next call). */
export function loadView<V extends LazyView>(view: V): ViewModule<V> {
  let module = pending[view] as ViewModule<V> | undefined
  if (!module) {
    module = (LOADERS[view] as () => ViewModule<V>)()
    module.then(
      (m) => { loaded[view] = m.default },
      () => { delete pending[view] }
    )
    ;(pending as Record<V, ViewModule<V>>)[view] = module
  }
  return module
}

/**
 * Runs `work` once the window is idle after its first content, with a deadline so a busy window
 * still gets it soon; returns a cancel for an effect's cleanup.
 */
export function whenIdle(work: () => void, timeout = 1000): () => void {
  // WebKit (macOS, Linux) has no requestIdleCallback.
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(work, { timeout })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(work, 300)
  return () => clearTimeout(id)
}

/** Fetches every lazy view's chunk. */
export function preloadViews(): void {
  for (const view of Object.keys(LOADERS) as LazyView[]) void loadView(view).catch(() => undefined)
}
