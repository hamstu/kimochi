// Keep ZIP decompression in the dictionary worker on Windows. Nested ZIP workers
// stall under WebView2's Tauri HTTP asset origin; the importer is already off the UI thread.
import { configure } from '../lib/zip.js'
import '../js/dictionary/dictionary-worker-main.js'

configure({ useWebWorkers: false })
